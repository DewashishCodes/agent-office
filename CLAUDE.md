# Agent Office

Phone-first web app that runs a team of Claude Code agents on a GitHub repo. The owner gives orders to one Orchestrator, approves its plan, specialist agents build the tasks as PRs, Reviewer and QA check them, the owner merges from the Inbox.

## Run

```
npm install
npm run doctor            # host prerequisites, each with its fix
npm run build             # builds web/ into web/dist
npm start                 # http://localhost:5190; the first start writes OWNER_TOKEN to .env and prints it
npm test                  # node:test with a fake claude CLI
npm run smoke:web         # renders every screen once through Vite SSR
```
Dev: `npm run dev:server` (5190, --watch) and `npm run dev:web` (Vite on 5191, proxies /api).

Needs on the host: Node 24, `git`, `claude` CLI logged in, `gh` CLI logged in with repo scope. The PC must stay on: agents run locally.

## Architecture

One Node process. `docs/CONTRACTS.md` is the detailed module contract; read it before changing any module.

- `server/db.js` schema + helpers (node:sqlite, `data/crew.db`). Use `setTask/setAgent/setOrder/log/addInbox` so changes broadcast.
- `server/bus.js` event bus; `index.js` forwards every event over SSE `/api/events`, the UI refetches on matching events.
- `server/runner.js` two engines behind one API. Task, Reviewer and QA runs are real interactive `claude` in a pty (`@lydell/node-pty`): control through hooks that call `POST /hook/:token` via `server/hook.mjs` (PermissionRequest -> `rules.permissionPolicy` or the owner, Stop -> turn end and result text, UserPromptSubmit), status line -> cost and 5-hour limit, the session jsonl -> `run_events`, tokens, `last_event`. Prompts are pasted once the input box is drawn; Take over gives the owner the keyboard in the browser; output kept in `data/pty/run-<id>.log`. Orchestrator, onboarding, integrate (and everything when `CREW_TERMINAL=json` or under the fake CLI) stay on `claude -p` stream-json with `--permission-prompt-tool stdio`.
- `server/support.js` the Support desk for chores (run, check, query, look things up): one resumed Haiku session per project in the main clone, no plan, worktree, PR or review. `rules.supportPolicy`: read-only commands and read-only SQL run, anything else asks, file edits and commits are denied. `suggest_order` lets it hand code changes to the team behind an owner button. Messages use `channel = 'support'`.
- `server/services.js` long-running processes Support starts (`service_start`), owned by the crew server so they outlive the session: one pty each, log in `data/services/`, URL detection, stop and restart; stopped when the server exits.
- `server/vault.js` shared context vault (notes, decisions, files under `data/vault/<project>/`, repo crew docs read live). Agents get titles in the prompt and the crew MCP tools vault_search, vault_read, vault_write.
- `server/crewmcp.js` HTTP MCP server at `/mcp/:token` (one token per run): crew_post, crew_ask, crew_read, crew_task_status so agents message and ask each other, the Orchestrator or the owner.
- `server/github.js` git and gh wrappers. Clone-level ops (clone, fetch, worktree add/remove, push) go through one serial queue; parallel agents raced on git lock files without it.
- `server/orchestrator.js` chat (a fresh session per request, one at a time per project and floor), plan JSON, revise, approve (rejects dependency loops), integrate. Command talk is split into chats (`chats` table, `chat_id` on messages and orders): the lead's prompt carries only the current chat's recent messages, and plan, question and integration messages follow their order's chat (`chatFor`). Posting without `chat_id` starts a new chat; the UI opens a new chat on every app visit.
- Floors (`roster.FLOORS`, `agents.floor`, `orders.floor`, `messages.floor`): Tech plus opt-in floors (Design, Docs, Marketing, Sales, Customer, Legal, Ops & Finance, Research), each with its own lead (role `orchestrator`), workers and reviewer. Non-tech floors write Markdown under their own top-level folder and ship PRs like code; review picks the task's floor reviewer, QA runs only where a floor has one (Tech). Command and Home switch floors; `POST /api/projects/:id/floors` opens one. Onboarding maps owned paths for Tech only.
- `server/scheduler.js` 5s tick dispatches ready tasks (deps done, owned paths cover files, max_parallel, daily budgets), runs each in `data/worktrees/<project>/crew-t<id>`, gate = changed files vs owned and protected paths, push + PR. Hotfix orders (`orders.hotfix`, from Quick task or the Command toggle) skip the PR, Reviewer and QA: after the gate the branch is rebased onto the project branch (`rebaseOnto`) and pushed to it, never forced. The project branch is `projects.default_branch`, switched from Settings (`PATCH default_branch`, checked against `GET /branches`). 60s poll for merges. `markMerged`/`markOnboarded` are the single idempotent merge path. Boot recovery puts interrupted tasks back.
- `server/pipeline.js` Reviewer then QA per PR, verdicts as fenced json, failures go through `failTask` (2 attempts, then Inbox).
- `server/onboarding.js` interview then office proposal. New projects come in three ways (GitHub repo, an existing folder, a blank folder with a PRD); the crew always works in its own clone, and a folder without a GitHub remote gets a private repo after the owner confirms. The Onboarding agent (resumed session) reads the repo or PRD, asks questions, and proposes floors and agents (`rules.parseProposal`); approving hires them and writes CLAUDE.md, PLAYBOOK, owned paths and `.crew/BRIEF.md` (PR, or straight to main for a blank repo plus a first Tech order). Every agent prompt includes BRIEF.md. Re-run from Projects or Settings.
- `server/index.js` Express routes, owner-token cookie auth, inbox actions. `server/notify.js` web push (VAPID in kv) and daily digest.
- `web/` React 19 PWA, plain CSS, hash routing. Home is the office (rail, agent space with Clawd desks and flying crew notes, the selected agent's real terminal via xterm.js, kanban strip, orders, Needs you). Bottom tabs: Home, Command, Needs you (Inbox screen: open items, history toggle), Agents, Board. Other screens: Login, Projects, Wall, Team, AgentProfile, Vault. Badge maps statuses to six owner words (`ui.jsx`); terminal runs have a Text view from run_events. Clawd GIFs in `web/public/clawd` (by CodeChrisB/MyClawd, credited in the README), state mapping in `web/src/clawd.js`.

## Conventions

- ESM, no TypeScript, no new deps unless clearly needed. execFile/spawn with arg arrays only, never shell strings (paths have spaces).
- No em or en dashes anywhere (code, comments, UI, docs).
- Comments only for the why. Commits may carry the Claude Co-Authored-By trailer.
- Statuses: task `planned -> in_progress -> in_review -> qa -> done | blocked` (+ `merged`), order `planning -> awaiting_approval -> in_progress -> ready_to_merge -> done | rejected`.

## Gotchas

- Child processes (agents, services) get the env without OWNER_TOKEN, PORT and CREW_* (`runner.childEnv`): a dev server would otherwise bind the crew port, and agents could read the token.
- Terminal runs need the native `claude.exe` on PATH (or `CREW_CLAUDE_PTY_BIN`). The child env drops the `CLAUDE_CODE_*` markers a parent session leaves, or the CLI stops saving its transcript (tokens and run_events would stay empty).
- Permission rules are guardrails, not a sandbox: an allowed command (`node file`, `npm run x`) runs code the agent can edit. `bashParts` refuses absolute, `~` and `..` arguments outside the cwd for every allowed command.
- Task agents and QA run with `acceptEdits`: Bash outside the `auto_allow_bash` list and file access outside the worktree ask the owner (Inbox, Wall). Deny rules (`git push`, `gh`, `.env`, protected paths) apply in every mode. An agent marked autonomous goes back to `bypassPermissions`.
- `npm test` uses `test/fake-claude.mjs` via `CREW_CLAUDE_BIN`; no real sessions in tests.
- `node --test test/` fails on Node 24 (treated as a file); the script uses the `"test/*.test.js"` glob.
- Files written by subagents may have CRLF endings; string-replace scripts must handle that.
- The server does not hot reload with `npm start`; restart after server changes (check no runs are `running` first).
