# Agent Crew v2: live windows, intervention, agent chatter, custom roster, many orders

## Context

The MVP (Phases A to C, loop verified on `DewashishCodes/agent-crew-sandbox`) is a demo: one Orchestrator chat, fire-and-forget `claude -p` runs that only surface a 200-char `last_event`, no way to talk to a running agent, agents that never talk to each other, a roster you can edit only through a broken Save button, and orders that work in parallel by accident with nothing stopping two of them from editing the same files.

The owner will run this against several real startup codebases, so the system must stay codebase-agnostic, and they want:
- a desktop **Wall** showing every agent's Claude Code window live, at the same time
- to **intervene**: (a) type into a running agent, (b) approve or deny specific actions, (c) take over in their own terminal
- agents that **ask questions mid-task** (to a peer, the Orchestrator or the owner) and **hand off** results to dependents, with the Orchestrator mediating only when it should
- a roster where agents can be **added and removed without breaking** anything
- **several orders in flight** at once, including small tasks that skip the Orchestrator

Budget runs through the normal Claude Code login (claude.ai subscription), not an API key.

## Decisions already made

1. **No Agent SDK.** It bundles its own CLI binary and expects `ANTHROPIC_API_KEY`. The installed CLI (2.1.306) exposes the same protocol: `--input-format stream-json` (inject user messages, send `control_request` for interrupt), `--permission-prompt-tool stdio` (permission prompts arrive as `control_request` on stdout), `--include-partial-messages`, `--resume`. The runner drives that directly. No new dependency.
2. **Agent-to-agent messaging goes through an HTTP MCP server inside this Express process** (`/mcp/:run_token`), passed per run with `--mcp-config` inline JSON. No child process, no MCP SDK: only `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping` over POST JSON-RPC. The run token in the URL identifies the calling agent.
3. **Transcripts live in SQLite** (`run_events` table) and stream over the existing SSE bus as `run_event`. The Wall appends; it never refetches whole transcripts.
4. **Plans assign by agent name, not role.** Two custom agents with role `custom` are ambiguous today (`rules.js:40-45` matches role as a tiebreak only). `matchAgent` prefers `agent` name, then role, then any owner of the paths.
5. **Gates that must survive `bypassPermissions` move to deny rules** passed via `--settings` inline JSON per run (`Bash(git push*)`, `Bash(gh *)`, `Read(.env*)`), instead of `--disallowedTools`. Deny rules apply before the permission mode.
6. **Phase order is strict**: E1 is the foundation; every later phase reads or writes `run_events` and the stdin channel.

## Wire protocol (confirmed from the SDK source and docs; CLI 2.1.306, pin it)

One JSON object per line on stdin and stdout. The SDK itself is only a wrapper over this.

- **Handshake:** first write `{"type":"control_request","request_id":"req_0","request":{"subtype":"initialize","hooks":null}}` (the SDK always does; harmless if optional). `system/init` on stdout gives `session_id` and a `capabilities` array.
- **User message:** `{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null,"session_id":"<sid>","priority":"next","origin":{"kind":"human"}}`. `priority`: `next` (after current tool calls), `later` (after the turn), `now` (interrupts). The spike checks that `priority` is honored on raw stdio.
- **Interrupt:** `{"type":"control_request","request_id":"req_N","request":{"subtype":"interrupt"}}`. Also available: `{"subtype":"set_permission_mode","mode":"acceptEdits"}` and `{"subtype":"set_model","model":"sonnet"}`. Replies come as `{"type":"control_response",...,"request_id"}`; match on `request_id`, give up after 60s. Interrupt cancels the pending tool call; the session stays on disk and is resumable with `--resume <sid>` (spike confirms; fallback is taskkill then `--resume`).
- **Permission prompt** (needs `--permission-prompt-tool stdio` and mode `default` or `acceptEdits`; `acceptEdits` auto-approves file edits but still prompts for Bash; `bypassPermissions`/`dontAsk` never prompt): incoming `{"type":"control_request","request_id":"<id>","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{...},"permission_suggestions":[...],"blocked_path":null,"tool_use_id":"..."}}`. Reply `{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"allow","updatedInput":<the input, required>}}}` or `..."response":{"behavior":"deny","message":"..."}`. An unanswered prompt pends forever on the CLI side, so the server enforces its own timeout.
- **Turns:** each turn ends with its own `result` line (sum usage across turns). The process stays alive while stdin is open; closing stdin ends it after any background work. Never SIGTERM a turn you want a `result` for.
- **Deny rules:** pass both `--settings '{"permissions":{"deny":["Bash(git push *)","Bash(gh *)","Read(./.env)","Read(./.env.*)"]}}'` and the same list via `--disallowedTools` (cheap insurance until the spike confirms merge semantics of inline `permissions`). Note the space in `git push *`. Deny applies under every permission mode.
- **MCP over HTTP:** `--mcp-config '{"mcpServers":{"crew":{"type":"http","url":"http://127.0.0.1:5190/mcp/<token>"}}}'` with `--strict-mcp-config`. Streamable HTTP lets the server answer POSTs with `application/json`; GET returns 405; notifications return 202 empty. Methods to implement: `initialize` (`protocolVersion` 2025-06-18, `capabilities:{tools:{}}`, `serverInfo`), `notifications/initialized`, `tools/list`, `tools/call`, `ping`. Bind 127.0.0.1, check `Origin`, the token is visible in the process list so it lives only as long as the run.
- Keep `delete env.CLAUDECODE` (the Python SDK does the same). Do not use `--bare` (it drops the claude.ai login).

Spike first: `scripts/spike-protocol.mjs` (deleted after) runs one session against the sandbox clone and exercises inject, interrupt + resume, a Bash permission prompt, and a `crew_post` MCP call. Only then rewrite the runner.

---

## Phase E1: live runner (foundation)

**Goal:** every run has a full, persisted, live transcript; a running session accepts injected messages, interrupts, permission answers; a stopped session can be resumed.

### Schema (`server/db.js`)
- `run_events (id, run_id, seq, type, json TEXT, created_at)` with index on `(run_id, seq)`. `type` is the stream line type (`assistant`, `user`, `result`, `system`, `control_request`, `owner`, `note`). Partial `stream_event` deltas are **not** stored, only emitted live.
- `runs`: add `turn INTEGER DEFAULT 0`, `state TEXT DEFAULT 'running'` values `running | waiting | paused | handed_off`, `pending_permission TEXT` (JSON of the open can_use_tool request or null).
- Prune: delete `run_events` older than 14 days on boot (keep the DB small; transcripts of merged tasks are on GitHub anyway).

### Runner (`server/runner.js`, rewrite, keep the exported surface)
Keep: `runClaude(opts)` returning the same promise shape (`{ok, text, session_id, tokens, cost, run_id}`), `killRun`, `killProject`, `tokensToday`, `projectTokensToday`, `runningCount`, agent status handling, rate-limit kv, Windows prompt file.

Change:
- Spawn with `--input-format stream-json --include-partial-messages --permission-prompt-tool stdio --settings <inline json: deny rules + protected paths as Read/Edit deny>` and, when `mcp` is requested, `--mcp-config <inline json>` (keep `--strict-mcp-config`). Prompt goes down stdin as the first user message; stdin stays open.
- Per line: insert into `run_events` (except `stream_event`), emit `run_event` `{run_id, seq, type, json}` over the bus unthrottled for assistant/user/result/control, throttled 1/s for `last_event` on the `run` row as today. Emit `stream_event` text deltas live as `run_delta` `{run_id, text}` (not stored).
- `result` handling: on each `result` bump `runs.turn`, add usage, set `state = 'waiting'`. If the run has no `keepOpen` flag (default for task, review, qa, orchestrator), close stdin and finish as today. `keepOpen` is used by the Wall when the owner is in a conversation with the agent (see E2): the run stays alive until the owner sends "resume task" or an idle timeout (10 min) closes it.
- New exports:
  - `sendToRun(run_id, text, {priority})`: writes a user message to stdin; stores it as a `run_events` row of type `owner`. Works in `running` and `waiting` states.
  - `interruptRun(run_id)`: control_request interrupt; sets `state = 'paused'`; falls back to taskkill if no response in 5s, keeping `session_id` so `resumeRun` works.
  - `resumeRun(run_id, text)`: for a `paused` or `handed_off` run with a `session_id`, spawn a fresh process with `--resume <sid>` and the given text as the first message, **reusing the same `runs` row** (so the task's promise chain in `scheduler.js:runTask` keeps waiting on one promise: the runner holds one deferred per run_id across respawns).
  - `answerPermission(run_id, request_id, allow, {message, updatedInput})`: writes the control_response, clears `pending_permission`.
  - `getRunEvents(run_id, after)` for the REST route.
- Permission requests (`control_request` with `can_use_tool`): call the `permissionPolicy(run, tool_name, input)` callback passed in by the caller (scheduler/pipeline). Returns `allow`, `deny`, or `ask`. On `ask`: store `pending_permission`, add an Inbox item of kind `permission` with the tool and input summary (push notification goes out through the existing `notify.js` hook on `inbox` events), emit. If unanswered after `settings.permission_timeout_min` (default 15) deny with "Owner did not answer in time, continue without it or ask via crew_ask".
- Boot: rows left `running`/`waiting` become `error` as today, but **tasks are no longer failed by recovery** (see E3 fix): they go back to `planned` keeping `attempts`.

### Policy (`server/rules.js`, pure, tested)
- `permissionPolicy(settings, agent, tool, input, cwd)`: Edit/Write/Read inside the worktree and not protected: allow. Bash: allow if the command matches `settings.auto_allow_bash` (defaults: `^(npm|pnpm|yarn|npx|node|git (status|diff|log|add|commit|checkout|switch|branch|merge|stash)|ls|cat|grep|rg|find|pytest|go test|cargo (test|build|check)|make)\b`), else `ask`. MCP `crew_*` tools: allow. Everything else: `ask`. Per agent `permissions.autonomous: true` short-circuits to `allow` for everything (the old bypass behavior, opt in).
- Permission mode per run: task and QA agents switch from `bypassPermissions` to `acceptEdits`; Reviewer and Orchestrator keep `dontAsk` (read-only tool set). `autonomous` agents stay on `bypassPermissions`.

### Routes (`server/index.js`)
- `GET /api/runs/:id` (row), `GET /api/runs/:id/events?after=<seq>` (max 500 rows).
- `POST /api/runs/:id/send {text}`, `POST /api/runs/:id/interrupt`, `POST /api/runs/:id/resume {text}`, `POST /api/runs/:id/kill`.
- `POST /api/runs/:id/permission {request_id, allow, message}`; Inbox action `permission:allow|deny` maps to it (phone path).
- `POST /api/runs/:id/handoff` (E2, see below).

### Tests
- `rules.test.js`: `permissionPolicy` cases (worktree edit allow, protected deny, bash allow list, bash ask, autonomous allow).
- `test/runner.test.js`: feed a fake child (a tiny node script that echoes stream-json lines from a fixture, waits on stdin) through `runClaude` with `CREW_DB=':memory:'`; assert `run_events` rows, `result` handling, `sendToRun` reaches the child's stdin, `interruptRun` writes a control_request. Spawn command made overridable via `CREW_CLAUDE_BIN` env for this.

### Verification
Run the spike against the sandbox repo: a task run where you (1) watch `run_events` fill, (2) `POST send` "also add a comment at the top of the file" mid-turn and see it acted on, (3) interrupt then resume, (4) trigger a Bash `ask` (e.g. the agent runs `curl`) and allow it from the Inbox on the phone.

---

## Phase E2: the Wall (desktop)

**Goal:** `#/wall` route, desktop first (from 900px, the existing sidebar breakpoint), phone gets a stacked list of the same tiles.

### Server
- `GET /api/projects/:id/wall`: agents with their current run (id, state, task title, turn, tokens today), open orders with task counts by status, pending permissions, last 50 crew messages (E4). One request to boot the screen; after that SSE.
- Handoff: `POST /api/runs/:id/handoff` interrupts and sets `state = 'handed_off'`; response carries `{cwd, session_id, command: "claude --resume <sid>"}`. `POST /api/runs/:id/resume` brings it back (E1). While `handed_off`, the scheduler's promise for that task simply keeps waiting; a task in that state is shown with a "Hand back" button.

### Web (`web/src/screens/Wall.jsx`, `web/src/wall.css`, `web/src/components/Transcript.jsx`)
- Layout at >= 900px: CSS grid of agent tiles (auto-fill, min 380px), a right rail (orders queue, crew feed, pending permissions). Below 900px: single column, rail collapses under the tiles.
- Tile: avatar, name, status dot, current task, state badge (`running | waiting | paused | handed_off | idle`), token meter vs daily budget, live `Transcript` tail (last 40 events, auto-scroll unless the user scrolled up), a one-line input ("Tell <name>…", submits `POST send`), buttons: Pause (interrupt), Resume, Kill (confirm), Take over (shows the copyable command in a `Sheet`), Expand.
- Expanded tile = full-height pane with the whole transcript (fetch `events?after` on open, then SSE), same controls, plus the pending permission card with Allow / Deny.
- `Transcript` renders event rows: assistant text (markdown-lite: fences and inline code only, no new dep), tool_use as a compact line (`Edit web/App.jsx`) expandable to the input, tool_result truncated to 2k, owner messages highlighted, result rows as a divider with tokens/cost. Live deltas (`run_delta`) append to a pending text row until the matching `assistant` event arrives.
- SSE: extend `api.js` `useEvents` matcher for `run_event` and `run_delta` by `run_id`. Keep refetch-on-event for everything else.
- Nav: add Wall as the first tab; on phone keep Command first.
- Phone Inbox: new item kind `permission` with Allow / Deny buttons (`ui.jsx` `Button` variants exist), and `question` items from agents (E4).

### Verification
Open the Wall in Chrome at desktop width during a real two-task order: both tiles stream at once; type into one; pause and resume; take over in a terminal, make an edit, hand back; check the layout at 380px.

---

## Phase E3: roster you can change safely

**Goal:** add, edit, clone, remove agents from the UI; nothing breaks mid-flight.

- Fix `AgentProfile.jsx` Save: drop `role` from the PATCH body (keep it read-only in the form). Add `role` to nothing; custom agents keep role `custom` and are addressed by name.
- Plan JSON: `"agent": "<name>"` replaces `"role"` for assignment (keep `role` optional for backwards compatibility with stored plans; `matchAgent` reads `task.agent` first). Orchestrator prompt lists each agent as `Name (role)` and says to assign by name. `tasks` table gets `agent_name TEXT` from the plan.
- Removal (`DELETE /api/agents/:id`): kill that agent's running runs (not counting an attempt), set its `in_progress | in_review | qa` tasks back to `planned` with `agent_id = null` and a note "Reassigned: <name> was removed", keep attempts. Blocked tasks stay blocked (today they are silently unblocked; stop that). The next tick re-matches by paths.
- Pause: also interrupt running runs of that agent (today pause is status only), resume continues them.
- Orchestrator and Reviewer/QA stay non-removable (`removable = 0`), but can be edited and paused; pipeline already skips a missing or paused step.
- Restart recovery: tasks in flight go back to `planned` **without** counting an attempt (today `recover` calls `failTask`, so two restarts block a task). Review/QA in flight restart from the review step: set status `in_review` tasks back to `in_review` and re-run `checkTask` on boot.
- Team screen: Add agent sheet already exists; add Edit (navigates to profile), and an inline role picker only at creation.
- Tests: `matchAgent` by name, removal reassignment (db test with `CREW_DB=':memory:'`), recovery not counting attempts.

---

## Phase E4: agents talk, and review feedback resumes the session

**Goal:** mid-task questions and handoffs; cheaper review loop.

### Crew MCP (`server/crewmcp.js`, mounted in `index.js` at `/mcp/:token`)
- A per-run random token maps to `{run_id, agent_id, task_id, project_id}` in memory; tokens die with the run.
- Tools exposed to every task/QA agent (Orchestrator gets `crew_post` and `crew_read` only):
  - `crew_post(to, text)`: `to` is an agent name, `"all"` or `"owner"`. Stored in a new `crew_messages (project_id, from_agent_id, to_agent_id|null, to_owner, task_id, text, kind message|question|answer, created_at)` table, emitted as `crew_message`. If the recipient has a running run, delivered immediately with `sendToRun` as `[Message from <name> about task #<id>]: ...` (priority `next`). If idle, queued and prepended to that agent's next task prompt ("Messages for you"). `to: owner` becomes an Inbox `question` item.
  - `crew_ask(to, question)`: blocking. `to: orchestrator` runs through the existing serialized `ask()` (`orchestrator.js`) with the task context and returns the answer text (the Orchestrator session gets a short system note that it is answering an agent, not the owner). `to: owner` creates the Inbox question and waits up to `settings.question_timeout_min` (default 30) for the answer (`inbox action question:answer` resolves a pending promise, also pushes the answer into the transcript); timeout returns "No answer yet. Decide yourself, state your assumption in the PR." `to: <peer>` posts, then waits up to 10 min for a `crew_post` back from that peer addressed to this agent (matched by `task_id`), else returns the timeout text.
  - `crew_read()`: messages addressed to me or all since this run started.
  - `crew_task_status(task_id?)`: titles, status, PR, branch, result summary of the tasks in my order (so dependents can look up what a sibling built).
- System prompt for task agents gets a paragraph: when to post (API shapes, renamed files, decisions a sibling task needs), when to ask (ambiguity that changes the output; prefer a peer or the Orchestrator; the owner only when it changes scope).
- Handoffs: store the run's final `result_text` as `tasks.result`; `taskPrompt` already lists dependency titles and branches, add each dependency's result summary (first 2k chars).
- Wall right rail shows the `crew_messages` feed with from/to; Command screen shows Orchestrator answers to agents as system lines.

### Review loop (`server/pipeline.js`, `server/scheduler.js`)
- On Reviewer `changes` or QA `fail`, when the task run has a `session_id` and the previous attempt did not crash: `resumeRun` the task session with the feedback as the next message, instead of a fresh session. Attempt count still increments; `MAX_ATTEMPTS` stays 2. Keep the fresh-session path when there is no session or the resume fails.
- Reviewer and QA get `crew_read` so they see what the author already explained.

### Tests
- `crewmcp.test.js`: JSON-RPC handshake, tools/list, tools/call for `crew_post` writing a row (in-memory DB), unknown token 401.
- `rules.test.js`: nothing new beyond prompt builders if extracted.

---

## Phase E5: many orders, direct tasks

- Command screen: orders list above the chat (status, tasks done/total, open the Board filtered). Sending a new order while one is planning queues it through the existing `ask()` lock; the chat shows "queued" on the ack.
- File lock in the scheduler (`rules.js` `overlaps(filesA, filesB)`: prefix overlap after stripping `/**` and `*`): a ready task whose files overlap files of a task `in_progress | in_review | qa` in another order waits, with `last_event`-style reason on the card ("Waiting for #12 (same files)").
- Orchestrator prompt: lists active orders with their tasks and files, and says to add `depends_on` across orders with `"order:<id>/t2"` keys or to avoid those files. `approvePlan` resolves cross-order keys to task ids.
- Direct task: `POST /api/projects/:id/tasks {agent, title, description, acceptance?, files?}` creates an order with status `in_progress`, one task assigned by name, no plan round trip. UI: "Quick task" button on the Wall tile and on the Team card (opens a `Sheet`).
- Integration: `integrateOrder` is per order already; nothing changes.

---

## Later (not in this plan, listed so they are not forgotten)
Usage screen with cost per order/agent; autonomy 2 (auto-merge S tasks after pass); standing agents (issue triage, CI fixer) on a schedule; GitHub webhooks instead of the 60s poll; Linux/WSL host with the Claude sandbox for untrusted repos; project settings screen; login rate limit; HTTPS via Tailscale (Phase D item 1).

## Cross-cutting rules for whoever implements
- Read `docs/CONTRACTS.md` first and update it per phase (runner surface, new tables, new routes, new events `run_event`, `run_delta`, `crew_message`).
- No em or en dashes anywhere. No new dependencies. ESM. `execFile`/`spawn` with arg arrays.
- Every DB write through `setTask/setAgent/setOrder/log/addInbox` or a new `addRunEvent` so the bus emits.
- Server restarts are frequent during this work: nothing may count a restart as a failed attempt (E3 fix lands early if E1 testing suffers from it).
- Each phase ends with a real run on the sandbox repo and a commit with the Co-Authored-By trailer.
