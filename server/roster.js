import { insert, getAgent } from './db.js'

// Default role templates (PRD "Default roster", Phase 1 roles). Onboarding later replaces owned_paths with repo-specific ones.
export const TEMPLATES = [
  {
    role: 'orchestrator', name: 'Orchestrator', specialty: 'Planning, assignment, integration',
    owned_paths: [], readonly_paths: ['**'],
    instructions: 'You are the team lead. You never edit code. You turn orders into plans, answer questions about the project, and check that finished work fits together.',
    model: 'opus', effort: 'high', max_parallel: 1, removable: 0,
    permissions: { open_pr: false, comment: true, run_tests: false, merge: false },
  },
  {
    role: 'planner', name: 'Planner', specialty: 'Specs and acceptance criteria',
    owned_paths: ['docs/specs/**'], readonly_paths: ['**'],
    instructions: 'Write short specs in docs/specs/ with clear acceptance criteria. No code changes.',
    model: 'sonnet', effort: 'medium', max_parallel: 1,
    permissions: { open_pr: true, comment: true, run_tests: false, merge: false },
  },
  {
    role: 'frontend', name: 'Frontend Dev', specialty: 'UI, state, styling, client tests',
    owned_paths: ['web/**', 'src/**', 'components/**', 'app/**', 'public/**'], readonly_paths: ['**'],
    instructions: 'Build screens and client logic. Match existing components and styles. Add or update client tests for what you change.',
    model: 'sonnet', effort: 'high', max_parallel: 1,
    permissions: { open_pr: true, comment: true, run_tests: true, merge: false },
  },
  {
    role: 'backend', name: 'Backend Dev', specialty: 'Endpoints, data models, server tests',
    owned_paths: ['api/**', 'server/**', 'db/**', 'prisma/**', 'lib/**'], readonly_paths: ['**'],
    instructions: 'Build endpoints and data models. Write integration tests for every endpoint you add or change.',
    model: 'sonnet', effort: 'high', max_parallel: 1,
    permissions: { open_pr: true, comment: true, run_tests: true, merge: false },
  },
  {
    role: 'reviewer', name: 'Code Reviewer', specialty: 'Reviews every PR against spec and conventions',
    owned_paths: [], readonly_paths: ['**'],
    instructions: 'Review the diff against the task acceptance criteria and CLAUDE.md conventions. Block only for real bugs, missing criteria or broken conventions.',
    model: 'sonnet', effort: 'high', max_parallel: 2,
    permissions: { open_pr: false, comment: true, run_tests: true, merge: false },
  },
  {
    role: 'qa', name: 'QA', specialty: 'Test runs and bug reports',
    owned_paths: [], readonly_paths: ['**'],
    instructions: 'Run the project test and build commands from CLAUDE.md on the branch. Check each acceptance criterion. Report pass or fail with evidence.',
    model: 'sonnet', effort: 'medium', max_parallel: 2,
    permissions: { open_pr: false, comment: true, run_tests: true, merge: false },
  },
]

export const template = role => TEMPLATES.find(t => t.role === role)

export function createAgent(project_id, fields) {
  const { default_on, ...f } = fields
  const id = insert('agents', { project_id, ...f })
  return getAgent(id)
}

// New project roster: every Phase 1 template.
export function seedRoster(project_id) {
  return TEMPLATES.map(t => createAgent(project_id, t))
}
