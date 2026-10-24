# Agent Office: improvement backlog

Every feature, fix and enhancement from the product, engineering and UI review of 2026-10-24. Findings came from reading the whole server and web code and from running the app against a copy of the database at 1366px and 390px.

How to work this list:
- Follow CLAUDE.md and docs/CONTRACTS.md: ESM, no TypeScript, no new dependencies, execFile with arg arrays, no em or en dashes anywhere, comments only for the why.
- Items are grouped by area and numbered. Priority is marked P1 (do first), P2, P3. The suggested order at the end is a reasonable sprint plan.
- Each item has: what to change, why, where in the code, and how to know it is done. Run `npm test` after every server change and `npm run build` after every web change.
- Several items touch the same component (the permission card, the merge card, the Home layout). Read the whole group before starting one of them.

## A. Safety and security

### A1. Bash allow list must not bypass the file sandbox (P1)
- What: in `bashParts` (server/rules.js) refuse any allowed command whose arguments contain an absolute path, `~`, or `..`, the same way it already refuses outward redirects (line 714). Narrow the default `auto_allow_bash` (server/db.js:724) so `node` only runs a relative file (`node <relative path>`), `npx` is removed or limited to a short list, and `npm` is limited to `npm test`, `npm run <script>`, `npm ci`, `npm install` with no arguments.
- Why: today `cat ~/.ssh/id_rsa` runs without asking because `cat` is allowed, and `node -e` or `npx` can run anything, including the `git push` and `gh` the deny rules block by prefix. The README promises "file access outside the worktree asks you first" and "the server does the pushing"; the code does not deliver that.
- Done when: rules.test.js covers `cat /etc/passwd`, `cat ~/x`, `head ../../x`, `node -e "..."`, `npx anything` all returning `ask`, and `npm test`, `node server/index.js`, `git status` still returning `allow`.

### A2. Reword the README security table honestly (P1)
- What: say the deny rules and the gate are guardrails against accidents, not against a determined model; an agent runs with the owner's git and gh credentials and a Bash command can reach anything the owner can.
- Where: README.md Security section, CLAUDE.md Gotchas.

### A3. Revocable sessions (P2)
- What: on login create a random session id, store it in `kv` (or a `sessions` table) with a created time; the cookie carries that id; the auth middleware looks it up; logout deletes it; add "Log out everywhere" that deletes all. Keep timing-safe comparison.
- Why: the cookie is `sha256(OWNER_TOKEN)` (server/index.js:28), valid until the token changes. Logout only clears the browser copy; a leaked cookie can never be revoked.
- Done when: a cookie copied before logout gets 401 after it.

### A4. Hook endpoint hardening (P3)
- What: an agent can read its own run token from its command line and `curl` `/hook/<token>?kind=hook` (curl to localhost is auto-allowed), which could end its own run early via a fake Stop or spoof cost in the status line. Have `server/hook.mjs` send a secret header that the server generates per run and passes to the hook through the settings JSON, and require it in `app.post('/hook/:token')`.
- Why: low likelihood, but it closes the one local endpoint that trusts the token alone.

## B. Backend reliability and operations

### B1. Remove worktrees and prune pty logs (P1)
- What: call `removeWorktree` (server/github.js:78, exported but never called) from `markMerged` and from `cancelTask`/`cancelOrder` for tasks with no open PR; delete `data/pty/run-<id>.log` files older than 14 days at boot, next to the `run_events` prune (server/db.js:714). Also clean `data/prompts` leftovers at boot.
- Why: `data/worktrees` holds every task ever run; pty logs are never deleted.
- Done when: merging a task removes its worktree folder (and the branch is already deleted by the squash merge); restarting with an old log file removes it.

### B2. One GitHub call per project in the PR poll (P1)
- What: replace the per-task `prState` loop in `poll()` (server/scheduler.js:392) with one `gh pr list -R <repo> --state all --json number,state,statusCheckRollup --limit 100` per project, then match tasks by `pr_number`.
- Why: twenty open PRs is twenty API calls a minute.
- Done when: the poll makes one gh call per project regardless of task count; scheduler.test.js asserts it.

### B3. Surface CI status (P1, pairs with D1)
- What: `prState` already computes `checks: pass|fail|pending|none` (server/github.js:296) but nobody reads it. Store it on the task (`tasks.checks`), update it in the poll, and emit the task so the merge card can show it.

### B4. Resume in-flight sessions after a restart (P2)
- What: in `recover()` (server/scheduler.js:417), for an `in_progress` task whose last task run has a `session_id`, keep the task in progress and re-dispatch with `resume: session_id` and the prompt "The crew server restarted. Check git status and git log, then continue the task." Fall back to the fresh prompt if the resume fails, as the retry path already does (scheduler.js:152).
- Why: today a restart throws away the agent's whole context and starts from the original prompt, at full cost.

### B5. Issues per task become a setting (P2)
- What: add `settings.github_issues` (default true). When false, `approvePlan` skips `createIssue` and `issueStatus` is a no-op. Expose it in Settings.
- Why: approval creates one issue per task sequentially before any task starts (server/orchestrator.js:968), and not every owner wants issues in their repo.

### B6. CI on three platforms and web smoke tests (P1)
- What: add `.github/workflows/ci.yml` running `npm ci`, `npm test`, `npm run build` on ubuntu, macos and windows. Add a small web test (node:test with jsdom is a new dependency, so instead: a Vite build plus a script that imports each screen module to catch import errors, or a Playwright-free render check using react-dom/server `renderToString` against fake data for each screen).
- Why: there is no CI at all (.github has only an issue template) and the README admits macOS and Linux are untested.

### B7. Health, logs, backup, indexes (P2)
- What: `GET /api/health` returning `{ ok, running_runs, projects, uptime }` (no auth, loopback only or with cookie); write server logs to `data/server.log` with rotation at 10 MB; a "Download backup" action in Settings that streams `data/crew.db` (checkpoint WAL first); indexes: `tasks(project_id, status)`, `runs(agent_id, status, started_at)`, `runs(project_id, started_at)`, `inbox(project_id, status)`, `messages(chat_id)`, `crew_messages(to_agent_id, delivered)`.

### B8. Weekly rate limit (P3)
- What: check whether the status line and the `rate_limit_event` expose a seven-day window alongside `five_hour`; if so store it in kv and show a second gauge.

### B9. Developer experience (P3)
- What: split server/index.js (790 lines) into route modules per domain (projects, orders and tasks, runs, agents, inbox, vault, support); add a `node --check`/lint step to CI; tag releases and keep a CHANGELOG.md with upgrade notes, since prompt changes alter agent behaviour silently.

### B10. Setup and running (P1)
- What:
  - `npm run doctor`: checks Node 24, git, `claude --version` (native binary on PATH or CREW_CLAUDE_PTY_BIN), `gh auth status` with repo scope, writes a report with the fix for each failure.
  - First boot without OWNER_TOKEN: generate one, write it to `.env`, print it once with a QR code (ASCII, no new dependency) of the login URL for the phone.
  - README section "Keep it running": nssm on Windows, launchd on macOS, systemd on Linux, plus a sleep-prevention note. Show a one-line hint in the UI when the server has been up less than a minute after an unclean exit.

## C. Product features

### C1. Merge card with checks, diff and cost (P1)
- What: on the Inbox merge card and the Board task sheet show: CI status from B3 (green, red, pending, none) with a warning and a second confirm when red; a "View diff" button opening a sheet that renders `prDiff` (new route `GET /api/tasks/:id/diff`) as a coloured unified diff; the task's total cost and tokens from its runs.
- Why: the owner is asked to merge from a phone without seeing the diff, CI or the price.

### C2. Cost before and after (P1)
- What: on the plan card show an estimate per task from the project's own history (median input+output tokens and cost of done tasks by size S, M, L; fall back to fixed guesses when there is no history) and a total; on orders (Home list, Board group header, Shipped view) show actual cost from runs. Add `settings.project_daily_cost_budget` in dollars next to the token budget, enforced in `tickProject` the same way.

### C3. Resolve conflicts action (P1)
- What: when `integrateOrder` finds a CONFLICTING PR or `restack`/`mergeTask` fails on a rebase conflict, add an inbox action "Resolve conflicts" that re-dispatches the task to its author on the same branch with notes "Rebase onto <default branch>, resolve the conflicts in <files>, run the tests, commit", without counting an attempt. The run gets `git rebase` allowed for that session only.
- Why: today both paths end in "needs a manual merge" and the owner is on a phone.

### C4. Retry with a note (P1)
- What: on the failure inbox card and the Board task sheet add "Retry with my note": a text box whose content is appended to `task.notes` before the retry, so the third attempt is steered by the owner.

### C5. Shipped view (P1)
- What: a screen (or Board mode) listing merged tasks newest first with title, agent, PR link, merge date, cost and the order they belong to; weekly totals at the top. Data already exists (`tasks.merged`, `runs`).
- Why: nothing today shows the owner what the office has delivered; it is the most motivating screen the product can have.

### C6. Permission "allow and don't ask again" (P1)
- What: a third button on permission cards (Inbox, Wall, Home) that allows the request and appends an escaped pattern for the command's first word (or the command up to its first argument) to `settings.auto_allow_bash`. Server: `POST /api/runs/:id/permission` accepts `remember: true`. Keep A1's path checks so this never widens file reach.

### C7. Notifications: deep link, actions, first-run prompt (P2)
- What: push payload URL points at the item (`/#/inbox?item=<id>` or the Needs you tab with the item expanded); `sw.js` adds notification actions Approve and Merge for plan and merge kinds, handled by posting the inbox action from the service worker with the cookie; after the first login on a touch device, show a one-time card explaining what arrives and offering "Turn on notifications".

### C8. Floors: lean by default (P2)
- What: keep Tech, Docs and Design in the "Open a floor" sheet as first-class; show the other six under an "Experimental" heading with a one-line note; the Onboarding prompt should prefer the three unless the owner asks.

### C9. First order nudge (P3)
- What: on Home when a project has no orders, the Orders panel shows two or three example orders as tappable chips that fill the order bar.

### C10. Activity feed screen (P3)
- What: the activity table has no screen. Add a project-wide feed (filter by kind) reachable from Home and the Shipped view.

## D. UI structure and navigation

### D1. Needs you gets a tab (P1)
- What: replace the Home badge and the orders-strip pill as the main entry: a fourth or fifth bottom tab "Needs you" with the open count, showing open items first and Inbox history as a toggle below (the Inbox screen becomes this tab). Keep the pill on Home as a shortcut.
- Why: approving, answering and merging is the owner's whole job and it is two taps deep.

### D2. Fold the Wall into Home and Team (P1)
- What: move the Wall's unique parts into the Home terminal tile (Take over, Hand back, Pause, Message, pending permission cards) and retire web/src/screens/Wall.jsx; the Agents tab opens Team. Fix the Back links in Team.jsx:192 and AgentProfile.jsx:227 to go to the previous screen (history back with a fallback to Home).
- Why: Wall duplicates Home; its tiles show raw transcripts (the Orchestrator tile shows plan JSON), have inner horizontal scrollbars, and the "Crew messages" heading overlaps the scrolled thread.

### D3. Plans where the order was given (P1)
- What: when a plan is awaiting approval, render the plan card inside the Home Orders panel (same `PlanCard` component) instead of the message "the plan comes back on Command"; remove the bare Approve button from the Home order list (Home.jsx:488) or make it open the card first.

### D4. Chats persist (P2)
- What: store the open chat id per project and floor in localStorage (not module state, Command.jsx:521) and open the most recent chat, or the one with an unanswered plan, on arrival. "New chat" stays one tap away.

### D5. One status vocabulary (P1)
- What: map every internal status onto six owner-facing labels in `Badge`: Waiting for you (awaiting_approval, plan, question, permission), Working (in_progress, running, working, planning), Being checked (in_review, qa), Ready to merge (done with pr and not merged, ready_to_merge, merge), Shipped (merged), Stuck (blocked, error, failed, failure, killed, rejected, canceled with distinct colour for canceled). Remove duplicates: run rows read "Ok · qa · ok" (badge and label say the same), task cards show Done plus a green "merged" word. Keep internal statuses unchanged in the API.

### D6. Plan editing that cannot produce a blocked task (P2)
- What: the Agent field becomes a `<select>` of agents on that floor that own paths (Command.jsx:702); add depends_on (multi-select of keys), files (textarea) and acceptance (textarea) to edit mode; validate on Approve edited plan that every file is covered by the chosen agent (reuse `matchAgent`) and show the error inline.

### D7. Permission card redesign (P1)
- What: show the command in a code block, strip the leading `cd "<worktree>" &&` (it is always the worktree), list the files it writes when detectable (sed -i, >, >>, tee, mv, rm, git add), hide the raw JSON behind a "Details" disclosure, and add the C6 button. Applies to Inbox Item, Wall Permission and the Home tile.
- Why: observed cards show the full absolute path twice and the JSON with escaped quotes; the decision is buried.

### D8. Elapsed time and absolute times (P2)
- What: show a running elapsed counter on the desk "doing" line and on kanban cards for in_progress tasks (reuse the timer in Working.jsx); every `ago()` gets a `title` with the full local timestamp.

### D9. Board (P2)
- What: hide empty columns (observed: five "Nothing here" columns and one Done column with 22 cards); merge In review and QA into one "Being checked" column; show Blocked as a banner above the board rather than a column; default to the Shipped view when nothing is in flight.

### D10. Header on small screens (P1)
- What: move "Stop all" into the overflow menu with the confirm step inside the menu (observed wrapping to two lines at 390px); show only the cost on screens under 480px, both gauges from 900px; the project select gets a fixed max width and ellipsis.

### D11. Home top row at laptop widths (P1)
- What: at 1366px the floor bar clips the Research floor and the agent strip clips "FRONTEND" against the layout presets. Give the floor bar and agent strip their own horizontal scroll with fade edges; move the three presets and the reset button into a small menu at the end of the terminal pane header; stop using the pixel font for the presets so they do not read as agent tabs.

### D12. Command sticky floor bar (P3)
- What: the floor bar is sticky under the header and messages scroll under it, so the top visible line is half hidden. Either put the floor bar in the header or give `.messages` a scroll-padding-top equal to the bar height.

### D13. Phone Home order (P1)
- What: on screens under 900px render a compact "Needs you" strip (count plus the first item's title and its primary action) above the room, and cap the room at 40vh when anything needs the owner (62vh with a 380px minimum today, office.css:239). Observed: at 390px the room fills the first screen and the Orders panel starts about 600px down.

### D14. Transcript view for terminal runs (P1)
- What: `Terminal.jsx` gets a Text toggle that renders `Transcript` from `run_events` for pty runs; default to Text when the run is finished, on screens under 900px, and when the pane is narrower than about 80 columns. Keep the live xterm as the default for a running run on desktop.
- Why: observed the Home pane for a finished run shows the last screen redraws of the TUI ("Skedaddling… (running Stop hook · 20s)", broken box lines); watchers on phones scale the font to 6px.

### D15. Offline shell and self-hosted font (P2)
- What: `sw.js` precaches index.html, the built assets and the Silkscreen font (copy the woff2 into web/public/fonts and reference it from CSS instead of Google Fonts); when `/api/me` fails offline show a "Can't reach your office" screen with the last cached Needs you list and a Retry button.

### D16. App badge (P2)
- What: call `navigator.setAppBadge(openInboxCount)` and `clearAppBadge()` wherever the open inbox list is loaded (App.jsx), wrapped in feature detection and try/catch.

### D17. Pixel labels (P2)
- What: raise desk tags, strip tabs, floor tabs and kanban meta from 10px to 12px (measured 10px and 11px); give `.tag` a max-width equal to the desk and `text-overflow: ellipsis`; measured tag widths reach 119px of a 127px desk with the Tech names alone, so "Social Media Manager" will overflow.

### D18. ARIA roles (P3)
- What: either wire `role="tablist"`/`role="tab"` (agent strip, floor bar, Orders/Support switch) with `tabpanel` ids and arrow-key handling, or replace them with plain buttons using `aria-pressed`; the `More` menu closes on Escape; `Sheet` restores focus to its opener on close.

### D19. Desktop Board overflow (P3)
- What: six columns at 190px minimum need about 1200px; with D9 (fewer columns) this mostly goes away, otherwise let columns shrink to 160px below 1200px.

### D20. Keyboard shortcuts (P3)
- What: `/` focuses the composer or order bar, `g h`, `g c`, `g b`, `g n` switch tabs, `Esc` closes sheets (already native). Show them in the menu.

## E. Onboarding and content

### E1. First-run after onboarding (P3)
- What: when onboarding finishes and the office is empty, Home shows a short welcome card: what the agents are, how to give the first order, where approvals appear, with a Dismiss.

### E2. Settings copy (P3)
- What: settings labels explain consequences in one line each (for example the auto-allow regex: "Commands matching this run without asking. Anything else waits for you in Needs you."). Hotfix copy in Command and Quick task already does this well; match it.

## Suggested order

Sprint 1 (safety and the merge decision): A1, A2, B6, B1, B2, B3, C1, C6, D7.
Sprint 2 (phone and structure): D1, D13, D14, D10, D11, D5, D3, B10.
Sprint 3 (product depth): C2, C3, C4, C5, D2, D9, D8, B4, B7.
Sprint 4 (polish): A3, B5, C7, C8, D4, D6, D15, D16, D17, D12, D18, D19, remaining P3 items.

## Verification checklist for each item

- `npm test` passes; new server logic has a test in test/*.test.js using the fake CLI.
- `npm run build` passes; the screen was looked at at 390px and 1366px.
- No em or en dashes were introduced (grep for them before committing).
- CONTRACTS.md and CLAUDE.md are updated when a route, setting, status or module contract changes.
