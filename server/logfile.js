import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { format } from 'node:util'

// Moves path to path.1 (dropping the old .1) once it passes max bytes, so a server left running never fills the disk.
export function rotate(path, max) {
  try {
    if (statSync(path).size < max) return
  } catch { return }
  if (existsSync(`${path}.1`)) rmSync(`${path}.1`, { force: true })
  renameSync(path, `${path}.1`)
}

// Everything the server prints also goes to path with a timestamp; the terminal keeps its output.
export function teeConsole(path, max = 10 * 1024 * 1024) {
  rotate(path, max)
  let n = 0
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console)
    console[level] = (...args) => {
      orig(...args)
      try {
        // Checking the size on every line would cost a stat per line; every 200 is plenty at 10 MB.
        if (++n % 200 === 0) rotate(path, max)
        appendFileSync(path, `${new Date().toISOString()} ${level === 'log' ? 'info' : level} ${format(...args)}\n`)
      } catch {}
    }
  }
}
