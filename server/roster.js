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
  {
    role: 'support', name: 'Support', specialty: 'Chores: run, check, query, look things up. No PRs.',
    owned_paths: [], readonly_paths: ['**'],
    instructions: '',
    model: 'haiku', effort: 'low', max_parallel: 1,
    permissions: { open_pr: false, comment: false, run_tests: true, merge: false },
  },
]

// Interviews the owner and proposes the office; never takes tasks (no owned paths).
export const ONBOARDER = {
  role: 'onboarding', floor: 'tech', name: 'Onboarding', specialty: 'Interviews the owner and proposes the office',
  owned_paths: [], readonly_paths: ['**'], instructions: '', model: 'opus', effort: 'high', max_parallel: 1, removable: 0,
  permissions: { open_pr: false, comment: false, run_tests: false, merge: false },
}

// Floors: one team per kind of work, each with its own lead (role orchestrator) and reviewer. Every floor works in the
// same repo; non-tech floors write documents in their own top-level folder, so they ship as PRs like code does.
// Tech, Design and Docs are the tried ones; experimental floors work the same way but are offered second.
export const FLOORS = [
  { key: 'tech', name: 'Tech', folder: null, color: '#d97757', blurb: 'Builds the product: code, tests, specs.' },
  { key: 'design', name: 'Design', folder: 'design', color: '#c49af0', blurb: 'UX flows, wireframes, UI specs, HTML mockups, brand and design tokens.' },
  { key: 'docs', name: 'Docs', folder: 'docs', color: '#6aa8f0', blurb: 'User guides, help center, API reference, changelogs.' },
  { key: 'marketing', experimental: true, name: 'Marketing', folder: 'marketing', color: '#e8b04a', blurb: 'Positioning, website copy, blog posts, social and launch drafts.' },
  { key: 'sales', experimental: true, name: 'Sales', folder: 'sales', color: '#6bd46d', blurb: 'Ideal customer profile, pitch, outreach drafts, objection handling.' },
  { key: 'customer', experimental: true, name: 'Customer', folder: 'customer', color: '#5fc4c4', blurb: 'Onboarding guides, FAQ, support replies, feedback summaries.' },
  { key: 'legal', experimental: true, name: 'Legal', folder: 'legal', color: '#ff8a7a', blurb: 'Terms, privacy policy, contracts and compliance checklists, all as drafts.' },
  { key: 'ops', experimental: true, name: 'Ops & Finance', folder: 'ops', color: '#a89e8e', blurb: 'Runway and pricing models, budgets, processes, vendor research.' },
  { key: 'research', experimental: true, name: 'Research', folder: 'research', color: '#8fd16a', blurb: 'Market and competitor research, user interview synthesis.' },
]
export const floorOf = key => FLOORS.find(f => f.key === key)

const DOC_RULES = folder => `You work on documents, not code. Write plain Markdown files under ${folder}/ (CSV for tables of numbers). Keep ${folder}/README.md as an index of what exists there. Read the product code and docs for facts; never invent features, numbers or quotes. Nothing you write is sent or published by you: it is a draft the owner ships.`
const PERMS = { open_pr: true, comment: true, run_tests: false, merge: false }

function floorTeam(key, lead, reviewer, workers) {
  const f = floorOf(key), own = [`${f.folder}/**`]
  return [
    {
      key: `${key}-lead`, floor: key, role: 'orchestrator', name: lead, specialty: `Leads the ${f.name} floor: plans, assigns, checks fit`,
      owned_paths: [], readonly_paths: ['**'],
      instructions: `You lead the ${f.name} floor (${f.blurb}). You never edit files. You turn orders into plans for your floor and check that finished work fits together. Your floor's work lives in ${f.folder}/.`,
      model: 'opus', effort: 'high', max_parallel: 1, removable: 0, permissions: { open_pr: false, comment: true, run_tests: false, merge: false },
    },
    ...workers.map(([wkey, name, specialty, extra, web = false]) => ({
      key: wkey, floor: key, role: wkey, name, specialty, owned_paths: own, readonly_paths: ['**'],
      instructions: `${DOC_RULES(f.folder)} ${extra}`, model: 'sonnet', effort: 'medium', max_parallel: 1, permissions: { ...PERMS, web },
    })),
    {
      key: `${key}-reviewer`, floor: key, role: 'reviewer', name: reviewer, specialty: `Reviews every ${f.name} PR`,
      owned_paths: [], readonly_paths: ['**'],
      instructions: `Review the change against the acceptance criteria. Check facts against the product code and existing docs, consistency of names and tone with what is already in ${f.folder}/, and that nothing outside ${f.folder}/ changed. Block only for wrong facts, missing criteria or content that would embarrass the company if shipped.`,
      model: 'sonnet', effort: 'medium', max_parallel: 2, permissions: { open_pr: false, comment: true, run_tests: false, merge: false },
    },
  ]
}

export const FLOOR_TEAMS = {
  design: floorTeam('design', 'Design Lead', 'Design Reviewer', [
    ['product-designer', 'Product Designer', 'User flows, wireframes, UI specs', 'Describe flows step by step with every state (empty, loading, error). For a screen, add a single-file HTML mockup under design/mockups/ with inline CSS and no external assets.'],
    ['brand-designer', 'Brand Designer', 'Brand guide, design tokens, visual language', 'Own design/brand.md and design/tokens.json (colors, type scale, spacing). Check contrast for every text color pair you propose.'],
  ]),
  docs: floorTeam('docs', 'Docs Lead', 'Editor', [
    ['tech-writer', 'Technical Writer', 'Setup guides, API reference, changelogs', 'Every command and endpoint you document must exist in the code; quote it exactly.'],
    ['help-writer', 'Help Center Writer', 'End-user how-tos and FAQ', 'Write for a non-technical user: short steps, one task per article.'],
  ]),
  marketing: floorTeam('marketing', 'Marketing Lead', 'Brand Editor', [
    ['content-writer', 'Content Writer', 'Website copy, blog posts, launch posts', 'Lead with the user problem, then the product. No superlatives you cannot back with the code.', true],
    ['seo-specialist', 'SEO Specialist', 'Keywords, page titles and meta, content briefs', 'Write content briefs and keyword maps; mark search volumes as estimates unless sourced.', true],
    ['social-media', 'Social Media Manager', 'Social and community post drafts', 'Draft posts per channel within its length limits; keep a content calendar in marketing/calendar.md.', true],
  ]),
  sales: floorTeam('sales', 'Sales Lead', 'Sales Reviewer', [
    ['sales-rep', 'Sales Rep', 'ICP, lead lists, outreach drafts, pitch', 'Outreach is drafts only and never claims a customer or result that is not in the repo docs. Lead research cites its source URL.', true],
  ]),
  customer: floorTeam('customer', 'Customer Lead', 'Support Reviewer', [
    ['success-manager', 'Customer Success', 'Onboarding guides, FAQ, reply templates', 'Reply templates are drafts the owner sends; keep a tone guide in customer/tone.md.'],
  ]),
  legal: floorTeam('legal', 'Legal Lead', 'Compliance Reviewer', [
    ['legal-drafter', 'Legal Drafter', 'Terms, privacy policy, contracts, compliance checklists', 'Start every document with: "Draft for review by a qualified lawyer, not legal advice." Base privacy text on what the code really collects and stores. Never invent laws or citations; list open questions per jurisdiction instead.', true],
  ]),
  ops: floorTeam('ops', 'Ops Lead', 'Finance Reviewer', [
    ['finance-analyst', 'Finance Analyst', 'Runway, pricing and unit economics models', 'Models are CSV plus a Markdown page with every assumption labelled as an assumption.'],
    ['ops-analyst', 'Operations Analyst', 'Processes, tooling and vendor research', 'Compare options in tables with price, limits and source links.', true],
  ]),
  research: floorTeam('research', 'Research Lead', 'Research Reviewer', [
    ['market-researcher', 'Market Researcher', 'Competitors, market size, interview synthesis', 'Every claim cites a source URL or the file it came from; separate facts from your inferences.', true],
  ]),
}

const ALL = [...TEMPLATES, ...Object.values(FLOOR_TEAMS).flat()]
// Tech templates are keyed by role, floor templates by key.
export const template = key => ALL.find(t => (t.key || t.role) === key)

export function createAgent(project_id, fields) {
  const { default_on, key, ...f } = fields
  const id = insert('agents', { project_id, ...f })
  return getAgent(id)
}

// New project roster: the Tech floor. Other floors open on demand.
export function seedRoster(project_id) {
  return TEMPLATES.map(t => createAgent(project_id, t))
}

export function openFloor(project_id, key) {
  return FLOOR_TEAMS[key].map(t => createAgent(project_id, t))
}
