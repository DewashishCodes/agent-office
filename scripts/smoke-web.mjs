// Renders every screen once with react-dom/server through Vite's SSR loader: catches import errors and first-render
// crashes without a browser or a new dependency. Effects (data loads) do not run on the server.
import { createServer } from 'vite'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'

// Load React from the real path, as Vite does, or a cwd that differs in case (Windows) gives two copies of React.
const require = createRequire(realpathSync.native('web') + '/')
const { createElement } = require('react')
const { renderToString } = require('react-dom/server')

const store = new Map()
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
globalThis.location = { hash: '#/home', reload() {} }
globalThis.window = globalThis
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.addEventListener = globalThis.removeEventListener = () => {}

const project = { id: 1, name: 'demo', repo: 'o/demo', default_branch: 'main', settings: { project_daily_token_budget: 1000 }, onboarding_status: 'done' }
const floors = [{ id: 'tech', name: 'Tech' }]
const ctx = { pid: 1, project, reloadProject() {}, floors, floor: 'tech', setFloor() {} }
const SCREENS = {
  Login: { onDone() {} },
  Projects: { projects: [project], current: 1, reload() {}, onPick() {} },
  Home: ctx, Command: { ...ctx, running: 0 }, Board: ctx, Team: ctx, AgentProfile: { ...ctx, id: 1 },
  Inbox: ctx, Wall: ctx, Vault: ctx, Onboarding: ctx,
}

const vite = await createServer({ root: 'web', configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', ssr: { noExternal: ['@xterm/xterm', '@xterm/addon-fit'] } })
let failed = 0
try {
  for (const [name, props] of Object.entries(SCREENS)) {
    try {
      const { default: Screen } = await vite.ssrLoadModule(`/src/screens/${name}.jsx`)
      const html = renderToString(createElement(Screen, props))
      console.log(`ok   ${name} (${html.length} chars)`)
    } catch (e) {
      failed++
      console.error(`FAIL ${name}: ${e.stack || e.message}`)
    }
  }
  const { default: App } = await vite.ssrLoadModule('/src/App.jsx')
  renderToString(createElement(App))
  console.log('ok   App')
} catch (e) {
  failed++
  console.error(`FAIL App: ${e.stack || e.message}`)
} finally {
  await vite.close()
}
process.exit(failed ? 1 : 0)
