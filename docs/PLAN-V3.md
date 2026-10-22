# Agent Crew v3: real terminals, the office, the vault

Owner asks (2026-10-22): real Claude Code terminals instead of the rendered transcript, crew messages that read as conversation, a Home laid out as an office (sketch below), Clawd animations from CodeChrisB/MyClawd, a shared context vault, general settings.

```
+--------+------------------------------+-------------------+
| config |  agent space (office floor)  |                   |
|  [][]  |  desks, one Clawd per agent, |  expanded         |
|  [][]  |  messages fly desk to desk   |  terminal of the  |
| vault  |                              |  selected agent   |
|  ( )   +------------------------------+                   |
|        |  kanban strip                |                   |
|        +------------------------------+-------------------+
|        |  orders and Needs you                            |
+--------+--------------------------------------------------+
```
Phone: stacked. Desks scroll sideways, tap a desk for its terminal full screen, then Needs you, orders, kanban.

## Spike results (scratchpad, Claude Code 2.1.307, Node 24, Windows)

- `@lydell/node-pty` (prebuilt ConPTY binaries, no compiler) runs interactive `claude` fine.
- Interactive mode keeps every control the stream-json runner had, through hooks passed with `--settings`:
  - `PermissionRequest` fires exactly when the CLI would show a permission dialog; its `decision.behavior` allow/deny is honoured. Replaces `can_use_tool`.
  - `Stop` fires at each turn end with `last_assistant_message`. Replaces the `result` line (Reviewer and QA verdicts).
  - `statusLine` command gets `cost.total_cost_usd`, `context_window.total_input_tokens/total_output_tokens`, `rate_limits.five_hour.used_percentage`. Replaces usage and `rate_limit_event`.
  - `--session-id <uuid>` fixes the session id; the transcript is `~/.claude/projects/<cwd with non-alphanumerics as ->/<id>.jsonl`, same assistant/user message shapes as stream-json. Replaces the event stream for `run_events` and `last_event`.
- The child must not inherit `CLAUDE_CODE_*` env markers, or transcript saving turns off.
- No trust prompt appeared in a fresh folder. The runner still answers one if it shows up.

## Phases

### T1 Terminal runner (server)
- New dep `@lydell/node-pty`. `runner.js` gets a pty engine for agent kinds `task | review | qa`; Orchestrator, onboarding and integrate stay on stream-json (their output is parsed, nobody watches them type). `CREW_TERMINAL=json` keeps the old engine for every kind (tests, fallback).
- `server/hook.mjs`: tiny script the hooks and status line run. Posts its stdin JSON to `/hook/:token` on loopback and prints the reply. One token per run, same as the MCP token.
- Hook routes: `PermissionRequest` -> `rules.permissionPolicy`, `ask` holds the response until the owner answers (Inbox, Wall, or the terminal itself) or `permission_timeout_min`. `Stop` -> result text, then the run ends unless kept open or the owner has the keyboard. `UserPromptSubmit` -> turn counter. Status line -> tokens, cost, 5h limit.
- Transcript tailer reads the session jsonl into `run_events` and `last_event`.
- Pty output kept per run in memory (ring, 256 KB) and appended to `data/pty/run-<id>.log` for replay after the run.
- Owner input: messages are pasted (bracketed paste + Enter), interrupt is Esc, take over gives the owner the keyboard in the browser (state `handed_off`, the run does not end on Stop until handed back). Idle timeout and respawn keep working through `--resume`.
- Routes: `GET /api/runs/:id/pty` (SSE: replay, then live chunks), `POST /api/runs/:id/pty/input {data}`, `POST /api/runs/:id/pty/resize {cols, rows}`.

### T2 Terminal in the browser
- New deps `@xterm/xterm`, `@xterm/addon-fit`. `Terminal.jsx` replaces `Transcript` wherever a run is shown. Read only until Take over; the Tell box stays.

### O1 Clawd assets
- Copy the needed MyClawd sets (loop GIFs, enter/exit where used) into `web/public/clawd/<set>/`. The repo has no license and Clawd is an Anthropic mark: fine while this repo is private, note it in the README.
- Map agent state and last tool to a set: Bash -> bash, Edit/Write -> writing, Read/Grep -> reading/search, git push -> git-push, PR -> git-pr, tests -> testing, review -> code-review, permission wait -> permission, idle -> idle-coffee/idle-book, done -> celebrate, error -> crash, handed off -> handoff, crew message -> new-mail.
- Our own sets with the MyClawd toolkit: two Clawds passing a note (crew messages), Clawd at a desk.

### O2 Office Home
- Layout per sketch, desktop first, stacked on the phone. Desks from `/wall`; selected desk drives the terminal pane.
- Crew messages as conversation: a note animates from the sender's desk to the receiver's, then lands as a speech bubble; a chat-style thread (avatars, bubbles, grouped by task) replaces the log list.
- Kanban strip and order section reuse Board and Home pieces.

### V1 Shared context vault
- Table `vault (id, project_id, kind doc|decision|file, title, body, path, tags, author_agent_id, created_at, updated_at)`. Files under `data/vault/<project_id>/`.
- Contents: repo docs (CLAUDE.md, .crew/PLAYBOOK.md, owned-paths, read from the clone, read only), owner notes, agent decisions, uploaded files.
- Crew MCP tools `vault_search(query)`, `vault_read(id)`, `vault_write(title, body, tags)`; prompts list titles only so agents pull what the task needs.
- UI: Vault sheet from the left rail; list, read, add note, upload.

### S1 General settings
- Project settings sheet over `PATCH /api/projects/:id` (budgets, permission timeout, auto-allow bash, digest hour).

Order: T1, T2, O1, O2, V1, S1. One commit per phase.
