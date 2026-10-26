// Syntax check of every server, script and test file with node --check: fast, no lint dependency.
import { execFileSync } from 'node:child_process'
import { globSync } from 'node:fs'

const files = globSync(['server/**/*.{js,mjs}', 'scripts/*.mjs', 'test/*.{js,mjs}'])
let failed = 0
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) }
  catch (e) { failed++; console.error(`FAIL ${f}\n${e.stderr}`) }
}
console.log(failed ? `${failed} of ${files.length} files failed` : `syntax ok, ${files.length} files`)
process.exit(failed ? 1 : 0)
