# Agent Office

A dev team of Claude Code agents you run from your phone.

<!-- Owner: replace with the GIF cut from the launch reel. -->
![Agent Office](docs/demo.gif)

## What it does

1. **Bring a repo.** Point Agent Office at a GitHub repo, an existing folder, or a blank folder with a product brief. An Onboarding agent reads it, asks you a few questions, and proposes an office: which agents to hire and which paths each one owns. You approve, and it writes `CLAUDE.md`, a playbook and a brief into the repo.
2. **Give an order.** On the Command screen you tell the Orchestrator what you want ("add a /health endpoint and a status badge"). It proposes a plan of tasks with dependencies. You approve, edit or reject it.
3. **The team builds.** Specialist agents pick up tasks in parallel, each in its own git worktree, running real Claude Code sessions you can watch live (and take over) in the browser. Every task becomes a pull request.
4. **Review and QA.** A Reviewer agent and a QA agent check every PR. Failures go back to the author with notes; a second failure lands in your Inbox.
5. **You merge.** When an order is ready, the PRs show up under Needs you with a note on the order to merge them in. One tap merges each.

Beyond Tech, you can open optional floors (Design, Docs, Marketing, Sales, Customer, Legal, Ops & Finance, Research). Each has its own lead, workers and reviewer, writes Markdown under its own folder, and ships PRs the same way code does. A Support desk handles chores (run the tests, start a dev server, query a database) without a plan or a PR.

## Requirements

- **Node 24** (uses the built-in `node:sqlite`).
- **git**.
- **Claude Code**, logged in to your Claude plan. Terminal runs need the native `claude.exe` (or `claude` on macOS and Linux) on `PATH`, from the native installer. With an npm install, set `CREW_CLAUDE_PTY_BIN` to a runnable path, or set `CREW_TERMINAL=json` to run every session headless.
- **GitHub CLI** (`gh`), logged in with the `repo` scope.
- **A computer that stays on.** The agents run on your machine, not in the cloud.

## Quickstart

```
git clone https://github.com/DewashishCodes/agent-office.git
cd agent-office
cp .env.example .env      # set OWNER_TOKEN to a long random string
npm install
npm run build && npm start
```

Open http://localhost:5190, log in with your `OWNER_TOKEN`, and add a project.

All state lives in `data/` (SQLite database, clones, worktrees, run logs). Delete it to start over.

## Phone access

The recommended way is [Tailscale Serve](https://tailscale.com/kb/1312/serve), which gives you HTTPS inside your private tailnet:

```
tailscale serve --bg 5190
```

Open the `https://<machine>.<tailnet>.ts.net` address on your phone (with the Tailscale app connected), log in, and use "Add to Home Screen" to install the app and turn on push notifications.

**Never expose port 5190 to the open internet** (no port forwarding, no public tunnels). Anyone who gets in can run commands on your computer through the agents.

## Security

Agents run real commands on your machine with your git and GitHub credentials. Read this before you start.

- **Approvals.** Task agents edit files in their worktree freely. Shell commands outside a safe list (`auto_allow_bash` in project settings) and file access outside the worktree ask you first, in the Inbox. Unanswered requests are denied after 15 minutes.
- **Deny rules** apply in every mode: no `git push`, no `gh`, no `.env` files, nothing under protected paths (`.env*`, keys, `secrets/`, `.github/workflows/`, `migrations/` by default). The server does the pushing.
- **Owned paths.** After each task a gate checks every changed file against the agent's owned paths and the protected paths, and sends the task back if anything is outside.
- **Merges are yours.** Work arrives as pull requests and you merge them. The exception is hotfix mode, which you turn on per order: it skips review and pushes straight to the project branch (never forced).
- **Autonomous agents.** Marking an agent autonomous turns off its approval prompts (Claude Code's `bypassPermissions`). Only the deny rules and the gate remain. Use it only on repos and machines you are willing to risk.
- **The owner token** is the only login. Keep it long and secret. Failed logins are rate limited per IP. Agents and services never see it.
- **Kill switch.** Each project has one that stops every session at once.

## Costs

Agent Office has no backend and no fees. Every session runs on your own Claude plan (or API key, if your Claude Code is set up that way) and counts against its usage limits. Each agent has a model and effort level, and projects and agents have daily token budgets in Settings; when a budget runs out, no new tasks start until the next day. The status line shows cost and your 5-hour limit while sessions run.

## Platform

Built and tested on Windows 11. macOS and Linux are untested: the code has paths for them, but nobody has run a full order there yet. Reports and fixes are welcome.

## Development

```
npm run dev:server        # API on 5190, restarts on change
npm run dev:web           # Vite on 5191, proxies /api
npm test                  # node:test with a fake claude CLI, no real sessions
```

`CLAUDE.md` has the architecture, conventions and gotchas; `docs/CONTRACTS.md` has the module contracts. Design history is in `docs/history/`.

## Credits

The pixel-art Clawd animations in `web/public/clawd/` are by [CodeChrisB/MyClawd](https://github.com/CodeChrisB/MyClawd), a fan project. Clawd is Anthropic's mascot. `pass-note` and `read-note` were drawn for this app with the MyClawd toolkit. Agent Office is not affiliated with or endorsed by Anthropic.

## License

[AGPL-3.0](LICENSE). If you run a modified version for others over a network, you must share its source.
