# Agent Crew: internal contracts

This file pins how the modules talk to each other. Each module has one owner during the build; do not change another module's file. If you need something from another module, code against the signature below.

Rules for everyone:
- Node 24, ESM (`import`), no TypeScript, no new dependencies beyond package.json (express, web-push, react, react-dom, vite).
- Built-ins to use: `node:sqlite` (via server/db.js), `node:child_process` `spawn`/`execFile` with argument arrays (never a shell string), `path.matchesGlob` for globs, `node:test` + `node:assert` for tests.
- Never use em or en dash characters anywhere (code, comments, UI text, docs). Use a plain hyphen, comma or colon.
- Comments only for the why. Match the terse style of server/db.js.
- Windows host. Paths may contain spaces (`C:\Users\Dewashish Lambore\...`). Always pass paths as args, never interpolate into a shell string.

## Shared modules (already written, do not edit)

`server/bus.js`: `bus` (EventEmitter, event name `'event'`), `emit(type, project_id, data)`.

`server/db.js`:
- `db`, `DATA_DIR`, `DEFAULT_SETTINGS`
- `all(sql, ...params)`, `get(sql, ...params)`, `run(sql, ...params)`: rows come back with JSON columns already parsed (settings, owned_paths, readonly_paths, permissions, plan, acceptance, depends_on, files, sub).
- `insert(table, obj) -> id`, `update(table, id, obj)`: objects/arrays are stringified for you.
- `getProject(id)`, `getAgent(id)`, `getTask(id)`, `getOrder(id)`, `activeAgents(project_id)`
- `setTask(id, fields)`, `setAgent(id, fields)`, `setOrder(id, fields)`: update + broadcast. Always use these for tasks, agents and orders.
- `log(project_id, kind, text, {agent_id, order_id, task_id, link})`: activity row + broadcast.
- `addMessage(project_id, role, text, order_id?)`, `addInbox(project_id, kind, title, {body, link, order_id, task_id})`, `resolveInbox(id)`
- `now()` returns `'YYYY-MM-DD HH:MM:SS'` (UTC, same as SQLite datetime('now')).

`server/rules.js` (Brain): pure helpers parseReply, parseVerdict, matchAgent, readyTasks, isAllowed, findCycle. No imports, tests use it directly.

`server/roster.js`: `TEMPLATES`, `template(role)`, `createAgent(project_id, fields)`, `seedRoster(project_id)`.

The schema is at the top of db.js. Read it; it is the data contract for the API and the UI too.

## Statuses

- task: `planned -> in_progress -> in_review -> qa -> done`, or `blocked` from anywhere. `done` means it passed Reviewer and QA; `merged = 1` once GitHub merged its PR.
- order: `planning -> awaiting_approval -> in_progress -> ready_to_merge -> done`, or `rejected`.
- agent: `idle | working | paused | blocked`. Removed agents have `removed_at` set and are hidden.
- Board columns map 1:1 to task status: Planned, In progress, In review, QA, Done, Blocked.

## Execution module (owner: Execution agent)

### server/runner.js
```js
runClaude({
  project_id, agent_id = null, task_id = null,
  kind,            // 'orchestrator' | 'task' | 'review' | 'qa' | 'onboarding' | 'integrate'
  cwd,             // working directory (worktree or clone)
  prompt,          // the user message, sent on stdin
  systemPrompt,    // appended via --append-system-prompt
  model = 'sonnet', effort = 'medium',
  allowedTools = [],       // e.g. ['Read','Grep','Glob']
  disallowedTools = [],
  permissionMode = 'dontAsk', // 'bypassPermissions' for task agents
  resume = null,           // session id to continue
}) -> Promise<{ ok, text, session_id, input_tokens, output_tokens, cost_usd, run_id }>
killProject(project_id)   // kill every running child of that project; mark runs 'killed'
killRun(run_id)
tokensToday(agent_id) -> number         // sum input+output tokens of runs started today (local day)
projectTokensToday(project_id) -> number
runningCount(agent_id) -> number        // runs with status 'running' for this agent
```
How it runs: `spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config', '--model', model, '--effort', effort, '--permission-mode', permissionMode, ...])`, prompt written to stdin, system prompt passed with `--append-system-prompt-file` (Windows command lines cap at about 32k chars). Clone-level git ops in github.js run through one serial queue so parallel agents never race on git lock files. `--setting-sources project` keeps the owner's personal hooks and plugins out of agent sessions.

stream-json lines (one JSON object per line): `type:'system', subtype:'init'` has `session_id`; `type:'assistant'` has `message.content[]` with `{type:'text'}` and `{type:'tool_use', name, input}`; `type:'rate_limit_event'` has `rate_limit_info.unifiedWindows.five_hour.utilization`; the final `type:'result'` line has `result` (final text), `is_error`, `session_id`, `total_cost_usd`, `usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`. Count input_tokens as input + cache_creation (cache reads are cheap; store them nowhere).

Each run inserts a `runs` row, updates `last_event` on every tool_use (e.g. `Edit web/App.jsx`, `Bash npm test`) and emits `emit('run', project_id, runRow)`, throttled to at most one emit per second per run. Store the latest five_hour utilization in `kv` key `rate_limit` as JSON `{utilization, resetsAt, at}`. Never throw for a failed session: resolve with `ok: false` and the error text. Agent status: set `working` when a task/review/qa run starts for an agent and back to `idle` when that agent has no running runs (do not overwrite `paused`).

### server/github.js
All via `execFile('gh' | 'git', args, { cwd })`, promisified. Throw an Error with stderr on failure.
```js
repoInfo(repo) -> { default_branch, name }        // gh repo view <repo> --json defaultBranchRef,name
ensureClone(project) -> local_path                 // data/repos/<owner>__<name>; clone if missing, else git fetch origin; updates projects.local_path
pullDefault(project)                               // fast-forward the clone's default branch to origin
createWorktree(project, branch, { from } = {}) -> { path, base_sha }
                                                   // data/worktrees/<project_id>/<branch with / replaced by ->; new branch from origin/<default> (or from `from`); reuses an existing worktree for that branch
mergeIntoWorktree(path, refs[])                    // git merge --no-edit each ref (dependency branches); throws on conflict after aborting
removeWorktree(project, path)
commitAll(path, message) -> boolean                // add -A, commit if dirty; false if nothing to commit
changedFiles(path, base_sha) -> string[]           // git diff --name-only base_sha..HEAD (forward slashes)
pushBranch(path, branch)
createIssue(project, { title, body }) -> number
setIssueStatus(project, issue_number, status)      // label "crew:<status>", removes other crew:* labels; creates labels on first use
createPR(project, { branch, title, body }) -> { number, url }
prComment(project, number, body)
mergePR(project, number)                           // gh pr merge --squash --delete-branch
prState(project, number) -> { state: 'OPEN'|'MERGED'|'CLOSED', checks: 'pass'|'fail'|'pending'|'none' }
prDiff(project, number) -> string                  // gh pr diff, truncated to 200k chars
```

### server/onboarding.js
```js
runOnboarding(project_id) -> Promise<void>
```
F1. Sets `projects.onboarding_status` running -> pr_open (or failed). Clone, worktree on `crew/onboarding`, run the Orchestrator agent profile with Read/Grep/Glob/Write/Edit, permissionMode `acceptEdits`, prompt: read the repo, write `CLAUDE.md` (what the app is, stack, commands to install/test/build, architecture, conventions), `.crew/PLAYBOOK.md` (handoffs, branch rules `crew/<task>`, definition of done), and `.crew/owned-paths.json` = `{ "<role>": { "owned_paths": [...], "readonly_paths": [...] } }` for every role in the roster. Gate: only those three paths may change. Commit, push, open PR "Crew onboarding", apply the proposed paths to the agents, store `onboarding_pr`, `addInbox(kind 'merge')`, log. When `scheduler` sees that PR merged it sets `onboarding_status = 'done'`.

## Brain module (owner: Brain agent)

### server/orchestrator.js
```js
chat(project_id, text) -> Promise<void>     // F2. Saves user message, runs Orchestrator (resume its session), saves reply. If the reply has a plan, creates the order and plan card.
revisePlan(order_id, feedback) -> Promise<void>  // F4. Re-plan; unchanged tasks keep their keys
approvePlan(order_id, tasks = null) -> void       // F4. Optional edited task list replaces plan.tasks. Creates task rows + issues, order in_progress, scheduler.kick()
rejectPlan(order_id) -> void
integrateOrder(order_id) -> Promise<void>         // all tasks done: Orchestrator checks the PR diffs fit; order ready_to_merge; one inbox 'merge' item per PR
parseReply(text) -> { text, plan | null }         // pure. Plan is the last ```json fenced block with a "tasks" array
```
Orchestrator session: `kind 'orchestrator'`, cwd = clone (pullDefault first), allowedTools Read/Grep/Glob, the Orchestrator agent's model/effort/instructions, `resume` = `projects.orchestrator_session_id` (store the new session id). If resume fails, retry once without resume. Acknowledge within 10s: post an orchestrator message "Got it, looking at the repo." before the session starts only if the user text looks like an order (otherwise just let the run status show).

System prompt includes the roster (name, role, specialty, owned paths) and tells it: ask up to 3 clarifying questions when the order is ambiguous (plain text, no plan), otherwise answer with a short summary plus the plan block. Plan JSON:
```json
{ "summary": "Add Google sign-in",
  "tasks": [
    { "key": "t1", "title": "Auth endpoint contract and handler", "role": "backend",
      "description": "...", "acceptance": ["..."], "size": "S|M|L",
      "depends_on": ["t0"], "files": ["api/auth/**"] } ] }
```

### server/scheduler.js
```js
start()   // setInterval tick every 5s + PR poll every 60s; also called once at boot
kick()    // run a tick soon (debounced)
// pure helpers, exported for tests:
matchAgent(agents, task) -> agent | null   // F6: active, not paused, role == task.role preferred, every task file covered by owned_paths (a file glob counts as covered when it matches or is under an owned glob); falls back to any agent whose paths cover; null if none
readyTasks(tasks) -> task[]                // status planned and every depends_on task is done
isAllowed(file, owned, protectedPaths) -> boolean
```
Tick per project that is not paused: for each ready task, pick/confirm agent (reassign if its agent is gone or paused; none -> `blocked` + inbox question "No agent covers <files>"), skip when `runningCount(agent) >= max_parallel` or `tokensToday(agent) >= daily_token_budget` or project over its budget (log once per day, inbox once). Dispatch = runTask:
1. `createWorktree(project, 'crew/t<id>')`, then `mergeIntoWorktree` each dependency branch, then record `base_sha` = HEAD.
2. Prompt = agent instructions + CLAUDE.md + .crew/PLAYBOOK.md (read from worktree if present) + agent notes + task (title, description, acceptance, files) + previous `notes` if retrying. Tell it: only edit owned paths, commit when done, never push.
3. `runClaude` kind 'task', `permissionMode 'bypassPermissions'`, disallowedTools `['Bash(git push*)', 'Bash(gh *)', 'Read(.env*)', 'Read(**/.env*)']`.
4. `commitAll`, `changedFiles(base_sha)`. Nothing changed -> failure. Any file not allowed (outside owned or inside protected) -> failure with the file list in notes.
5. `pushBranch`, `createPR` (body: summary, acceptance checklist, `Closes #<issue>`, dependency PRs to merge first), task `in_review`, `setIssueStatus`, log with PR link, then `pipeline.checkTask(task_id)`.
Failure = `attempts + 1`, notes set, back to `planned`; when attempts reach 2 -> `blocked` + inbox `failure`. A crashed session (ok false) counts as one attempt (retry once, then escalate).
PR poll: tasks with pr_number and merged = 0 -> `prState`; MERGED -> `merged = 1`, log; order `done` when all its tasks merged. Also onboarding PR merged -> project onboarding_status 'done'.

### server/pipeline.js
```js
checkTask(task_id) -> Promise<void>   // F11
```
Reviewer (role reviewer, kind 'review', cwd = task worktree, allowedTools Read/Grep/Glob, `permissionMode 'dontAsk'`, prompt includes acceptance + `git diff base_sha..HEAD` output) must end with ```json {"verdict":"approve"|"changes","notes":"..."}```. Post its notes with `prComment`. Then status `qa`; QA (role qa, kind 'qa', cwd = worktree, allowedTools Read/Grep/Glob/Bash, `permissionMode 'bypassPermissions'`, same disallowed list as tasks) ends with ```json {"verdict":"pass"|"fail","report":"..."}```, posted with `prComment`. If the Reviewer or QA agent is removed or paused, skip that step and log it. Any changes/fail -> same failure path as the scheduler (notes = feedback, re-dispatch on the same branch and worktree). Both pass -> task `done`, `setIssueStatus`, and when every task of the order is done -> `orchestrator.integrateOrder`. Unparseable verdict counts as approve/pass with a logged warning. Export the failure helper from scheduler.js as `failTask(task_id, notes)` so both use one path.

Tests (owner: Brain agent) in `test/*.test.js`: parseReply, matchAgent, readyTasks, isAllowed. Set `process.env.CREW_DB = ':memory:'` before importing anything that touches db.js.

## API module (owner: API agent)

### server/index.js
Express 5, JSON bodies, port `process.env.PORT || 5190`. Exits with a clear message when `OWNER_TOKEN` is missing. Serves `web/dist` statically with SPA fallback to index.html. On boot: `scheduler.start()`, `initNotify()`.

Auth: `POST /api/login {token}` compares with `OWNER_TOKEN` (timing-safe) and sets cookie `crew=<sha256 of token>` (HttpOnly, SameSite=Lax, Secure when the request is https, 30 days). Every other `/api/*` route requires the cookie. `GET /api/me -> {ok:true}`. `POST /api/logout`.

Responses are DB rows as read by db.js (JSON columns parsed). Errors: `{ error: "message" }` with 4xx/5xx. Long work (chat, onboarding, plan actions that run Claude) returns `202 {ok:true}` immediately and reports progress through SSE.

| Method | Path | Does |
| --- | --- | --- |
| GET | /api/projects | list |
| POST | /api/projects `{repo}` | `repoInfo`, insert project, `seedRoster`, start `runOnboarding` in background, return project |
| GET | /api/projects/:id | project + `{ running_runs, tokens_today, rate_limit }` |
| PATCH | /api/projects/:id `{name?, settings?}` | settings merged shallowly |
| POST | /api/projects/:id/onboard | re-run onboarding |
| POST | /api/projects/:id/kill | kill switch: `paused = 1`, `killProject`, running tasks back to planned, log |
| POST | /api/projects/:id/resume | `paused = 0`, `kick()` |
| GET | /api/projects/:id/messages | last 200, oldest first |
| POST | /api/projects/:id/messages `{text}` | `orchestrator.chat` (202) |
| GET | /api/projects/:id/orders | newest first |
| GET | /api/orders/:id | order + its tasks |
| POST | /api/orders/:id/approve `{tasks?}` | `approvePlan` |
| POST | /api/orders/:id/revise `{feedback}` | `revisePlan` (202) |
| POST | /api/orders/:id/reject | `rejectPlan` |
| GET | /api/projects/:id/tasks?agent_id=&order_id= | tasks with `agent_name` |
| GET | /api/tasks/:id | task + `activity` + `runs` |
| POST | /api/tasks/:id/retry | attempts 0, notes '', status planned, kick |
| GET | /api/templates | `TEMPLATES` |
| GET | /api/projects/:id/agents | active agents, each with `tokens_today`, `current_task` (title of its in_progress task or null), `last_event` of its running run |
| POST | /api/projects/:id/agents `{role? , ...fields}` | from template by role merged with fields, or from scratch (role 'custom') |
| GET | /api/agents/:id | agent + `notes` + recent 20 `tasks` + recent 10 `runs` (with result_text) |
| PATCH | /api/agents/:id | edit profile fields (whitelist the agents columns) |
| POST | /api/agents/:id/clone | copy with name "<name> 2" (next free number) |
| POST | /api/agents/:id/pause, /resume | status paused / idle |
| DELETE | /api/agents/:id | 400 if not removable; set removed_at; its planned/blocked tasks -> agent_id null, planned; kick |
| POST | /api/agents/:id/notes `{text}` | add a note |
| GET | /api/projects/:id/inbox?status=open | newest first |
| POST | /api/inbox/:id/action `{action, text?}` | see below |
| GET | /api/projects/:id/activity?limit=100 | newest first |
| GET | /api/events | SSE: forwards every bus event as `data: {"type","project_id","data"}\n\n`; heartbeat comment every 25s |
| GET | /api/push/key | `{ publicKey }` |
| POST | /api/push/subscribe `{subscription}` | upsert into push_subs |

Inbox actions by kind:
- plan: `approve` -> approvePlan, `reject` -> rejectPlan, `revise` (text) -> revisePlan
- merge: `merge` -> `mergePR` then task merged = 1 (or onboarding done), log; `dismiss`
- question: `answer` (text) -> `orchestrator.chat(project_id, 'Answer to "<title>": <text>')`; `dismiss`
- failure: `retry` -> same as task retry; `dismiss`
Every action except a failed one resolves the inbox item.

### server/notify.js
```js
initNotify()                      // VAPID keys generated once and stored in kv ('vapid'); listen to bus 'event' with type 'inbox' and data.created -> sendPush; start digest timer
publicKey() -> string
sendPush(title, body, url = '/') // to every push_subs row; delete subscriptions that return 404/410
digestNow(project_id) -> string   // plain text: yesterday's done/merged tasks, in review, open inbox count, tokens used. Logged as activity kind 'digest' and pushed
```
Digest timer: check every 10 minutes; at `settings.digest_hour` local time, once per day per project (kv key `digest:<project_id>` = date).

## UI module (owner: UI agent)

`web/index.html`, `web/src/main.jsx`, `web/src/App.jsx`, `web/src/api.js`, `web/src/styles.css`, `web/src/screens/{Login,Command,Board,Team,AgentProfile,Inbox,Projects}.jsx`, `web/public/{manifest.json,sw.js,icon.svg}`.

- React 19, no router library: tab state in App plus `location.hash` (`#/command`, `#/board`, `#/team`, `#/agent/12`, `#/inbox`). Project switcher at the top (stored in localStorage, try/catch).
- `api.js`: `api(path, {method, body})` with `credentials: 'same-origin'`, throws on non-2xx with the server's `error`; a 401 shows Login. `useEvents(onEvent)` hook with one shared `EventSource('/api/events')`. Screens refetch their list when an event of the matching type and project arrives (simple and correct beats clever).
- Mobile first: works at 380px, bottom tab bar (Command, Board, Team, Inbox, with an open-inbox count badge), left sidebar from 900px. Light and dark via CSS variables and `prefers-color-scheme`. Plain CSS, no framework. Tap targets at least 44px. Labels on every input.
- Command: chat with the Orchestrator; orchestrator message with `order_id` renders the plan card (summary, tasks with owner role, size, depends_on, acceptance on expand) with Approve, Edit (inline edit of title/role/size and a feedback box -> revise), Reject while the order is `awaiting_approval`. Show "Orchestrator is thinking" with the run's `last_event` while an orchestrator run is running. Kill switch button in the header menu (with a confirm step inside the UI, not `window.confirm`).
- Board: six columns (horizontal scroll on mobile, one column visible at a time with a column picker is fine), filter by agent and by order; tap a card -> sheet with description, acceptance, notes, attempts, PR link, issue link, activity and runs, Retry button when blocked.
- Team: card per agent (initials avatar, name, role, status dot, current task, today's tokens, live last_event), Add (pick template or blank), Clone, Pause/Resume, Remove (hidden for the Orchestrator). Tap -> Agent profile.
- Agent profile: form for every profile field (owned/readonly paths as one glob per line), notes list + add note, recent tasks, recent runs with their result text (read-only "talk to this agent" view).
- Inbox: open items newest first, one-tap actions per kind (see API), link to GitHub, answer box for questions. Toggle to show resolved.
- Projects screen when there is no project yet: input "owner/repo" -> POST /api/projects, show onboarding status.
- PWA: manifest (name "Agent Crew", standalone, icon.svg), `sw.js` handles `push` (showNotification with title/body/url) and `notificationclick` (focus or open url). Register the SW in main.jsx. A "Turn on notifications" button in the Inbox header that subscribes with the key from /api/push/key.

## v2 additions (docs/PLAN-V2.md, phases E1 to E5)

These override the MVP notes above where they disagree.

### Runner (server/runner.js)
Sessions run with `--input-format stream-json --include-partial-messages --replay-user-messages --permission-prompt-tool stdio`; stdin stays open. The prompt is the first user message.
```js
runClaude(opts) -> Promise<{ ok, text, session_id, input_tokens, output_tokens, cost_usd, run_id, stopped }>
  // new opts: permissionPolicy(tool, input) -> 'allow'|'deny'|'ask', mcp (crew tool names), keepOpen
  // disallowedTools go to --settings permissions.deny and --disallowedTools
  // resolves once per run, across respawns; stopped = killed on purpose, never count it as an attempt
sendToRun(run_id, text, { priority = 'next' })   // owner message; respawns with --resume when the child is gone
interruptRun(run_id)                             // state paused, process kept; 5s without reply -> child killed, row kept
resumeRun(run_id, text?)                         // continue; the next result ends the run
handoffRun(run_id) -> { cwd, session_id, command } // child stopped, state handed_off
answerPermission(run_id, request_id, allow, { message })
getRunEvents(run_id, { after } | { tail })
killRun(run_id), killProject(project_id), isLive, canDeliver, runForToken, liveRuns, describe
```
Run `state` (while `status = 'running'`): `running | waiting | paused | handed_off`. `pending_permission` is a JSON array of open requests. `total_cost_usd` is cumulative per process, so cost = earlier processes + latest result. A `can_use_tool` the policy answers `ask` becomes an Inbox item of kind `permission` (`run_id`, `ref` = request_id), denied after `settings.permission_timeout_min`.

Permission modes: task and QA agents `acceptEdits` (+ policy), `bypassPermissions` only when `agent.permissions.autonomous`; Reviewer and Orchestrator `dontAsk`. QA denies Edit/Write. Deny rules: `scheduler.denyRules(project)`.

### Rules (server/rules.js)
`permissionPolicy(settings, agent, tool, input, cwd)`, `overlaps(filesA, filesB)`; `matchAgent` prefers `task.plan_agent` (or `task.agent`), then role, then any covering agent.

### Crew MCP (server/crewmcp.js, mounted at `/mcp/:token`, loopback only)
Tools `crew_post(to, text)`, `crew_ask(to, question)`, `crew_read()`, `crew_task_status(task_id?)`. `to` is an agent name, `all`, `orchestrator` or `owner`. Exports `CREW_TOOLS`, `mcpNames`, `mcpHandler`, `answerFromOwner(inboxItem, text)`, `takeQueued(agent_id)`. Orchestrator gets post/read, Reviewer read, task and QA agents all four.

### Schema
- `run_events (run_id, seq, type, json)`: types `prompt | assistant | user | result | control_request | owner | note`. Pruned after 14 days.
- `crew_messages (project_id, from_agent_id, to_agent_id, to_owner, task_id, text, kind, delivered)`.
- `runs`: `turn`, `state`, `pending_permission`. `tasks`: `plan_agent`, `result`, `wait_reason`. `inbox`: `run_id`, `ref`.
- Settings: `permission_timeout_min` 15, `question_timeout_min` 30, `auto_allow_bash` (regex).

### Routes
| Method | Path | Does |
| --- | --- | --- |
| GET | /api/projects/:id/wall | agents with newest run, open orders with task counts, pending permissions, last 50 crew messages |
| GET | /api/runs/:id, /api/runs/:id/events?after=&tail= | run row, transcript rows |
| POST | /api/runs/:id/send `{text}`, /interrupt, /resume `{text?}`, /handoff, /kill, /permission `{request_id, allow, message?}` | intervention; kill blocks the task without an attempt |
| POST | /api/projects/:id/tasks `{agent, title, description?, acceptance?, files?}` | quick task: one-task order for a named agent |
| ALL | /mcp/:token | crew MCP |
Inbox: `permission` items take `allow | deny | dismiss`; `question:answer` on an agent's item goes back to that agent.

### Events
`run_event {run_id, seq, type, json, created_at}`, `run_delta {run_id, text}` (live text, not stored), `crew_message` (row with from_name, to_name).

### Plans and scheduling
Plan tasks carry `"agent": "<name>"` (`role` still read for old plans). `depends_on` may hold `"order:<id>/<key>"`. A ready task waits while a task of another order with overlapping files is in progress, review or QA (`wait_reason`). Restarts and removals never count an attempt; review and QA cut off by a restart or the kill switch run again (`resumeChecks`). A retry after review feedback resumes the last clean task session.
