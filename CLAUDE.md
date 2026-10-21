# Agent Crew

Phone-first web app that runs a team of Claude Code agents on a GitHub repo. The owner gives orders to one Orchestrator, approves its plan, specialist agents build the tasks as PRs, Reviewer and QA check them, the owner merges from the Inbox. Source PRD: PRD Phase 1 MVP (F1 to F11).

## Run

```
cp .env.example .env      # set OWNER_TOKEN to a long random string
npm install
npm run build             # builds web/ into web/dist
npm start                 # http://localhost:5190, log in with OWNER_TOKEN
npm test                  # node:test, server/rules.js helpers
```
Dev: `npm run dev:server` (5190, --watch) and `npm run dev:web` (Vite on 5191, proxies /api). Ports 5173 and 5180 belong to other local apps.

Needs on the host: Node 24, `git`, `claude` CLI logged in, `gh` CLI logged in with repo scope. The PC must stay on: agents run locally.

## Architecture

One Node process. `docs/CONTRACTS.md` is the detailed module contract; read it before changing any module.

- `server/db.js` schema + helpers (node:sqlite, `data/crew.db`). Use `setTask/setAgent/setOrder/log/addInbox` so changes broadcast.
- `server/bus.js` event bus; `index.js` forwards every event over SSE `/api/events`, the UI refetches on matching events.
- `server/runner.js` keeps one `claude -p` per run with stdin open (stream-json in and out, `--permission-prompt-tool stdio`, `--setting-sources project --strict-mcp-config`). Stores the transcript in `run_events`, streams text deltas, accepts owner messages, interrupt, resume, handoff; permission prompts go to `rules.permissionPolicy` or the owner. Tracks tokens, cost, 5-hour limit (kv `rate_limit`), `last_event`.
- `server/crewmcp.js` HTTP MCP server at `/mcp/:token` (one token per run): crew_post, crew_ask, crew_read, crew_task_status so agents message and ask each other, the Orchestrator or the owner.
- `server/github.js` git and gh wrappers. Clone-level ops (clone, fetch, worktree add/remove, push) go through one serial queue; parallel agents raced on git lock files without it.
- `server/orchestrator.js` chat (resumed session per project, one at a time per project), plan JSON, revise, approve (rejects dependency loops), integrate.
- `server/scheduler.js` 5s tick dispatches ready tasks (deps done, owned paths cover files, max_parallel, daily budgets), runs each in `data/worktrees/<project>/crew-t<id>`, gate = changed files vs owned and protected paths, push + PR. 60s poll for merges. `markMerged`/`markOnboarded` are the single idempotent merge path. Boot recovery puts interrupted tasks back.
- `server/pipeline.js` Reviewer then QA per PR, verdicts as fenced json, failures go through `failTask` (2 attempts, then Inbox).
- `server/onboarding.js` writes CLAUDE.md, `.crew/PLAYBOOK.md`, `.crew/owned-paths.json` in the target repo as one PR.
- `server/index.js` Express routes, owner-token cookie auth, inbox actions. `server/notify.js` web push (VAPID in kv) and daily digest.
- `web/` React 19 PWA, plain CSS, hash routing. Screens: Login, Projects, Command, Wall (live agent tiles, desktop first), Board, Team, AgentProfile, Inbox.

## Conventions

- ESM, no TypeScript, no new deps unless clearly needed. execFile/spawn with arg arrays only, never shell strings (paths have spaces).
- No em or en dashes anywhere (code, comments, UI, docs).
- Comments only for the why. Commits may carry the Claude Co-Authored-By trailer.
- Statuses: task `planned -> in_progress -> in_review -> qa -> done | blocked` (+ `merged`), order `planning -> awaiting_approval -> in_progress -> ready_to_merge -> done | rejected`.

## Gotchas

- Task agents and QA run with `acceptEdits`: Bash outside the `auto_allow_bash` list and file access outside the worktree ask the owner (Inbox, Wall). Deny rules (`git push`, `gh`, `.env`, protected paths) apply in every mode. An agent marked autonomous goes back to `bypassPermissions`.
- `npm test` uses `test/fake-claude.mjs` via `CREW_CLAUDE_BIN`; no real sessions in tests.
- `node --test test/` fails on Node 24 (treated as a file); the script uses the `"test/*.test.js"` glob.
- Files written by subagents may have CRLF endings; string-replace scripts must handle that.
- The server does not hot reload with `npm start`; restart after server changes (check no runs are `running` first).

## Status (2026-10-21)

v2 (docs/PLAN-V2.md, E1 to E5) implemented. Verified on the sandbox: two agents in parallel (PRs #12, #13), an owner message injected mid-task and acted on, permission prompts answered from Inbox and from the run route, pause and resume, take over and hand back (session resumed with --resume), a quick task, a crew_post between agents. Earlier: MVP loop (onboarding PR #1, PRs #4, #5).

Not yet verified live: crew_ask (blocking answers), permission timeout, removing an agent mid-run, Kill from the Wall, file lock between two real orders, the Wall in a browser at 380px, push notifications.

## Next (Phase D, still open)

1. HTTPS for phone access: Tailscale serve (recommended) or a cloudflared tunnel. Ask the owner which.
2. Install the PWA on the phone, turn on notifications, confirm a push arrives.
3. Try a Reviewer rejection path and the kill switch on live runs (parallel agents are verified).
4. Optional: push this repo to GitHub (no remote yet), add a project settings screen (PATCH /api/projects/:id exists), login rate limit.

Skipped for MVP on purpose: autonomy levels 2 and 3, GitHub App and webhooks, schedules, Usage screen, templates, contracts checking, collaborators.
