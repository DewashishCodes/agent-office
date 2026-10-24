# Plan: work docs/IMPROVEMENTS.md in phases

## Progress (updated 2026-10-25)
- [x] **Phase 1** done on branch `phase1-safety-merge` (20 commits, from `main`).
- [x] **Phase 2** done on branch `phase2-phone-structure` (38 commits, stacked on phase 1).
- [x] **Phase 3** done on branch `phase3-product-depth` (75 commits, stacked on phase 2). All three pushed; no PRs opened yet.
- [ ] **Phase 4** next. Start a `phase4-polish` branch from `phase3-product-depth` (or from `main` once the three are merged).

State at the end of phase 3: `npm test` 58/58, `npm run build` and `npm run smoke:web` green, no dashes in the diff. CI (`.github/workflows/ci.yml`) has not run yet; it will on the first push or PR, and Linux/macOS may expose Windows-only test assumptions.

Known gaps to keep in mind (not blockers):
- Not exercised end to end with live git/GitHub/claude: C3 Resolve conflicts (rebase run + force-with-lease push) and B4 resume after restart. Unit tests cover the state changes and the one-run `git rebase` allowance.
- `answer()` in server/index.js (the `remember: true` glue for C6) has no route test.
- Two commits in phase 3 (the `git mv` of Wall.jsx to components/AgentTile.jsx and wall.css to agent.css) do not build on their own; the next commit fixes the imports.
- D8: elapsed on Board task cards counts from `tasks.updated_at`, an approximation of dispatch time.
- D14: the narrow-pane Text default is decided once on mount, not on splitter drags.
- B10: no QR code (an encoder is well over 150 lines); the first boot prints the token and URL.
- Desktop Home: a plan card in the short Orders panel scrolls inside it; the Plan layout preset gives it room.

Working notes for the next session:
- Write code that contains backslashes with the Edit/Write tools, or a script file: shell heredocs here halve `\\`, which once turned a regex `\b` into a backspace.
- `npm test | tail` hangs (a test child keeps the pipe open); redirect to a file instead: `npm test > log 2>&1`.
- Visual checks: copy the DB with `VACUUM INTO` to the scratchpad, `UPDATE projects SET paused = 1`, run `CREW_DATA_DIR=<copy> PORT=5199 OWNER_TOKEN=<test> node server/index.js`, log in with fetch, and use same-origin iframes at 390px (the browser window does not resize). Boot recovery closes open permission items, so seed those after start.

## Context
docs/IMPROVEMENTS.md (review of 2026-10-24) lists 46 items (A1-A4, B1-B10, C1-C10, D1-D20, E1-E2), every one assigned to a phase below, across safety, backend, product, UI and onboarding. The goal is to ship all of them in reviewable phases, safety first, so the README's promises hold and the owner can make merge decisions from a phone.

Notes from checking the code:
- The doc's line numbers are stale (e.g. Command.jsx:702, db.js:724 point past end of file). Locate by name: `bashParts` and `permissionPolicy` in server/rules.js, default `auto_allow_bash` at server/db.js:240, `poll()` scheduler.js:388, `recover()` scheduler.js:417, `prState`/`prDiff`/`removeWorktree` in server/github.js (all exist, `removeWorktree` unused), cookie `sha` at server/index.js:27, `createIssue` in orchestrator.js:265, `matchAgent` rules.js:40.
- `bashParts` is shared by the task policy and Support (`noRedirects`). A1's path check goes inside `bashParts`, so Support gets it too (it runs in the main clone, so that is correct).
- `.github` has only an issue template; tests live in test/*.test.js with test/fake-claude.mjs.

## Working rules (every phase)
- One branch + one PR per phase (or per sub-group if it gets big), commits per item.
- After server changes `npm test`; after web changes `npm run build` and a look at 390px and 1366px via the run skill.
- Grep for em/en dashes before each commit. Update docs/CONTRACTS.md and CLAUDE.md when a route, setting, column or module contract changes.
- New DB columns (`tasks.checks`, sessions, settings keys) go through the existing schema/migration pattern in server/db.js.
- Stop after each phase for the owner's review before starting the next.

## Phase 1: Safety and the merge decision (doc Sprint 1) [done]
Server first, then the cards that consume it.
- [x] **A1** `bashParts`: return null when any part has an arg that is absolute (`/x`, `C:\`), starts with `~`, or contains `..` (allow `/dev/null`, `/tmp/` the way redirects already do). Narrow default `auto_allow_bash`: `node <relative file>` only, drop `npx`, `npm (test|ci|install|run \S+)` with nothing extra after install. Tests in rules.test.js exactly as listed in the doc.
- [x] **A2** README Security section + CLAUDE.md Gotchas: guardrails against accidents, not a determined model.
- [x] **B1** call `removeWorktree` from `markMerged` and from `cancelTask`/`cancelOrder` when no open PR; at boot next to the `run_events` prune delete `data/pty/run-*.log` older than 14 days and `data/prompts` leftovers. Test in scheduler.test.js.
- [x] **B2 + B3** `poll()`: one `gh pr list -R repo --state all --json number,state,statusCheckRollup --limit 100` per project; reuse the checks reduction from `prState` (extract it to a small shared function in github.js). Add `tasks.checks`, set it via `setTask` so it broadcasts. Test asserts one gh call per project.
- [x] **B6** `.github/workflows/ci.yml`: ubuntu, macos, windows; Node 24; `npm ci`, `npm test`, `npm run build`, plus a `scripts/smoke-web.mjs` that renders each screen with `react-dom/server` `renderToString` against fake props/api stubs (no new dep).
- [x] **C1** `GET /api/tasks/:id/diff` (wraps `prDiff`); Inbox merge card and Board task sheet show checks badge (second confirm when red), "View diff" sheet with coloured unified diff, task cost/tokens summed from its runs.
- [x] **C6 + D7** permission card as one shared component used by Inbox, Wall (since removed) and the Home tile: command in a code block with leading `cd "<worktree>" &&` stripped, detected written files, raw JSON under Details, third button "Allow, don't ask again". `POST /api/runs/:id/permission` takes `remember: true` and appends an escaped first-word pattern to `settings.auto_allow_bash` (A1 path check still applies).

## Phase 2: Phone and structure (doc Sprint 2) [done]
- [x] **D1** Needs you becomes a bottom tab (Inbox screen with open items first, history toggle); keep the Home pill.
- [x] **D13** under 900px: compact Needs you strip above the room; room capped at 40vh when anything is open (office.css).
- [x] **D14** Terminal.jsx Text toggle rendering the existing `Transcript` from `run_events`; default Text when finished, under 900px, or pane under ~80 cols.
- [x] **D10** header: Stop all into overflow menu with inline confirm; cost only under 480px; project select max width + ellipsis.
- [x] **D11** floor bar and agent strip scroll with fade edges; layout presets into a small menu in the terminal header, normal font.
- [x] **D5** `Badge` maps statuses to six owner labels; remove duplicate run-row and task-card words. API untouched.
- [x] **D3** `PlanCard` rendered in the Home Orders panel; Home's bare Approve opens the card.
- [x] **B10** `npm run doctor` script; first boot without OWNER_TOKEN generates and writes it to .env and prints an ASCII QR of the login URL (small hand-written encoder, or skip QR if it exceeds ~150 lines and print the URL; decide when implementing); README "Keep it running"; UI hint after unclean restart.

## Phase 3: Product depth (doc Sprint 3) [done]
- [x] **C2** plan-card estimates from median tokens/cost of done tasks by size (fixed fallback); actual cost on orders; `settings.project_daily_cost_budget` enforced in `tickProject` next to the token budget.
- [x] **C3** "Resolve conflicts" inbox action from `integrateOrder`/`restack`/`mergeTask` conflicts: re-dispatch to the author on the same branch, no attempt counted, `git rebase` allowed for that run only.
- [x] **C4** "Retry with my note" appends to `task.notes` before retry (Inbox failure card, Board sheet).
- [x] **C5** Shipped view (Board mode) from `tasks.merged` + runs, weekly totals.
- [x] **D2** move Wall's unique parts (Take over, Hand back, Pause, Message, permission cards) into the Home terminal tile; delete Wall.jsx; Agents tab opens Team; Back links use history back with Home fallback.
- [x] **D9** Board: hide empty columns, merge In review + QA, Blocked as banner, default to Shipped when idle. (Covers most of **D19**.)
- [x] **D8** elapsed counter (reuse Working.jsx timer) on desk line and in-progress cards; `title` with full timestamp on every `ago()`.
- [x] **B4** `recover()`: resume in-progress tasks with the last run's `session_id` and a restart prompt, fall back to fresh as the retry path does. Test with fake CLI.
- [x] **B7** `GET /api/health`; `data/server.log` with 10 MB rotation; Settings "Download backup" (WAL checkpoint then stream); listed indexes.

## Phase 4: Polish (doc Sprint 4 + remaining P3) [next]
- [ ] **A3** sessions table, random id cookie, logout deletes, "Log out everywhere"; timing-safe lookup. Test: old cookie gets 401.
- [ ] **A4** per-run hook secret passed in settings JSON, sent by hook.mjs as a header, required by `/hook/:token`.
- [ ] **B5** `settings.github_issues` (default true) gating `createIssue`/`setIssueStatus`; Settings toggle.
- [ ] **C7** push deep links, sw.js Approve/Merge actions, one-time notifications card.
- [ ] **C8** Tech, Docs, Design first-class; others under "Experimental"; onboarding prompt prefers the three.
- [ ] **D4** chat id per project+floor in localStorage; open most recent or the one with an unanswered plan.
- [ ] **D6** plan edit: agent `<select>`, depends_on, files, acceptance; validate with `matchAgent` inline.
- [ ] **D15** sw.js precache shell + self-hosted Silkscreen woff2; offline screen with cached Needs you.
- [ ] **D16** `setAppBadge` in App.jsx with feature detection.
- [ ] **D17** pixel labels to 12px, `.tag` ellipsis. **D12** scroll-padding-top on `.messages`. **D18** aria-pressed buttons, Escape closes More, Sheet restores focus. **D20** keyboard shortcuts.
- [ ] **B8** weekly rate limit gauge if the status line exposes it (check first; skip if not).
- [ ] **B9** split server/index.js into route modules, `node --check` step in CI, CHANGELOG.md + tags.
- [ ] **C9** example order chips; **C10** activity feed screen; **E1** welcome card; **E2** settings copy.

## Verification
- Per phase: `npm test` green (new tests: rules A1 cases, scheduler poll call count + worktree removal + resume, sessions 401), `npm run build` green, smoke-web script passes, CI workflow green on all three OSes once pushed.
- UI items checked in the running app (`npm run build && npm start`, run skill) at 390px and 1366px, including a real permission card, a merge card with diff, and the Needs you tab.
- Dash grep clean; CONTRACTS.md / CLAUDE.md updated for new routes (`/api/tasks/:id/diff`, `/api/health`), columns (`tasks.checks`), settings (`github_issues`, `project_daily_cost_budget`), and the removed Wall screen.
