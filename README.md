# Agent Crew

Run a team of Claude Code agents on your GitHub repo and manage them from your phone.

You tell the Orchestrator what you want ("add a /health endpoint and a status badge"). It reads the repo and proposes a plan. You approve it. Backend, Frontend and other specialist agents build their tasks in separate git worktrees and open PRs. A Code Reviewer and QA check every PR. When everything passes, the PRs land in your Inbox and you merge them with one tap.

## Setup

Requirements: Node 24, git, the `claude` CLI (logged in to your Claude plan) and the `gh` CLI (logged in).

```
npm install
cp .env.example .env    # set OWNER_TOKEN to a long random string
npm run build
npm start
```

Open http://localhost:5190, log in with your `OWNER_TOKEN`, and add a repo as `owner/name`. The first thing the crew does is open an onboarding PR with `CLAUDE.md`, a team playbook and the proposed owned paths per agent. Merge it, then give your first order on the Command screen.

## Screens

- **Command**: chat with the Orchestrator; plans appear as cards with Approve, Edit and Reject.
- **Board**: tasks by status (Planned, In progress, In review, QA, Done, Blocked).
- **Team**: your agents, their live status and today's usage; add, clone, pause, remove.
- **Agent profile**: role, owned paths, instructions, model, budget, notes, recent runs.
- **Inbox**: plans to approve, PRs to merge, questions and failures.

## Safety

- Agents never push to your default branch; everything arrives as a PR and you merge.
- Each agent may only change its owned paths; anything else sends the task back.
- Protected paths (secrets, `.env`, migrations, CI workflows) are off limits to every agent.
- Daily token budgets per agent and per project. A kill switch stops every session on a project.

Agents run on your own machine using your Claude plan, so the PC has to stay on while they work.

See `CLAUDE.md` for architecture and status, and `docs/CONTRACTS.md` for module contracts.

## Clawd art

The pixel-art Clawd animations in `web/public/clawd/` come from [CodeChrisB/MyClawd](https://github.com/CodeChrisB/MyClawd) (a fan project; Clawd is Anthropic's mascot and mark). That repo publishes no license, so the files are used here for a private, personal install only. Remove them, or get the author's permission, before making this repository public. `pass-note` and `read-note` were drawn for this app with the MyClawd toolkit.
