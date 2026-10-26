# Changelog

Agent behaviour follows its prompts, so prompt changes are listed here too: they change what the crew does without any code you would notice. Upgrade notes say what to do after pulling.

## Unreleased: phase 4, polish

Upgrade notes:
- Every browser and phone has to log in again once: the login cookie is now a session of its own instead of a hash of the owner token.
- Restart the server after pulling (`npm run build`, then `npm start`), with no run `running`.
- The app now caches its shell for offline use. After an update the first load may still show the previous build; a reload picks up the new one.

Changes:
- Sessions: Log out ends only this device; Log out everywhere (header menu) ends them all.
- Terminal runs' hooks need a per-run secret besides the run token, kept in a settings file outside the worktree.
- Settings: "Open a GitHub issue for every approved task" (`github_issues`, on by default), and every setting says what happens when it applies.
- Notifications open the item's card in its project; plan and merge notifications have Approve and Merge buttons. Touch devices get a one-time card offering notifications.
- Floors: Tech, Docs and Design come first; the others are listed as experimental. **Prompt change:** onboarding proposes an experimental floor only when the owner asks for that kind of work.
- Command reopens the chat you left, or the one with a plan waiting.
- Plan editing: the agent is picked from the floor's workers, and depends_on, files and acceptance are editable; an edited plan that names an agent who cannot take a task is refused with the reason.
- Offline: self-hosted pixel font, a cached app shell, and a "Can't reach your office" screen with the last Needs you list.
- The open Needs you count shows on the installed app's icon.
- Header shows the weekly limit (7d) next to the five hour one.
- Home: welcome card and example orders while the office has no work yet; an Activity screen with a kind filter.
- Accessibility: 12px pixel labels, toggle buttons with aria-pressed, Escape closes menus, sheets give focus back. Keyboard: `/` focuses the message box, `g` then `h c n a b` switches tabs.
- Code: `server/index.js` split into `server/routes/*`; `npm run check` runs `node --check` over the code in CI.

## Phase 3, product depth (PR #3)

- Plan estimates from this project's finished tasks, cost per order, a daily dollar budget.
- Resolve conflicts from a merge card, Retry with a note, a Shipped view with weekly totals.
- The Wall folded into Home and Team; a calmer Board; elapsed time on running work.
- In-progress tasks resume their agent session after a restart. `GET /api/health`, `data/server.log`, Download backup.

## Phase 2, phone and structure (PR #2)

- Needs you is a tab; on phones a compact strip sits above the room.
- Terminal runs have a Text view. One status vocabulary of six words.
- Plans show where the order was given. `npm run doctor`, and the first start writes the owner token to `.env`.

## Phase 1, safety and the merge decision (PR #1)

- The Bash allow list can no longer reach outside the worktree; a narrower default list.
- Worktrees and old terminal logs are cleaned up; one GitHub call per project in the PR poll; CI status on tasks.
- CI on Linux, macOS and Windows. Merge cards show checks, the diff and the cost. Permission cards with "Allow, don't ask again".
