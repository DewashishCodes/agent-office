import { api } from '../api.js'
import { Button, ErrorText, Sheet, useAction } from '../ui.jsx'
import { light } from './Office.jsx'

// Floors with at least one agent, in building order. Tech is always there.
export function openFloors(floors, agents) {
  const has = new Set((agents || []).map(a => a.floor))
  return (floors || []).filter(f => f.key === 'tech' || has.has(f.key))
}

// The saved floor if it is open here, else Tech.
export const currentFloor = (open, floor) => open.find(f => f.key === floor) || open[0] || { key: 'tech', name: 'Tech', color: '#d97757' }

// Elevator buttons: one per open floor, red pulse when someone there waits for the owner, + opens a new floor.
export function FloorBar({ open, agents, floor, onPick, onAdd, canAdd }) {
  return (
    <div className="floor-bar">
      <div className="strip-tabs" role="tablist" aria-label="Floors">
        {open.map(f => {
          const ask = (agents || []).some(a => a.floor === f.key && a.run && light(a) === 'ask')
          return (
            <button key={f.key} type="button" role="tab" aria-selected={f.key === floor} className={`strip-tab floor-tab ${ask ? 'l-ask' : ''}`}
              style={{ '--floor': f.color }} onClick={() => onPick(f.key)} title={ask ? `Someone on ${f.name} is waiting for you` : f.blurb}>
              <i className="floor-chip" aria-hidden="true" />{f.name}
            </button>
          )
        })}
      </div>
      {canAdd && <button type="button" className="floor-add" onClick={onAdd} title="Open a new floor" aria-label="Open a new floor">+</button>}
    </div>
  )
}

export function OpenFloorSheet({ pid, floors, open, templates, onOpened, onClose }) {
  const [run, busy, error] = useAction()
  const closed = (floors || []).filter(f => !open.some(o => o.key === f.key))
  const go = key => run(async () => { await api(`/projects/${pid}/floors`, { method: 'POST', body: { floor: key } }); onOpened(key) })
  return (
    <Sheet title="Open a floor" onClose={onClose}>
      <div className="stack">
        <p className="muted small">A floor is a team with its own lead and reviewer. Its work lands as PRs in its own folder of the repo.</p>
        <ul className="list">
          {closed.map(f => (
            <li key={f.key} className="card row-card" style={{ '--floor': f.color }}>
              <span className="grow">
                <span className="title"><i className="floor-chip" aria-hidden="true" /> {f.name}</span> <span className="muted small mono">{f.folder}/</span>
                <span className="muted small" style={{ display: 'block' }}>{f.blurb}</span>
                <span className="small" style={{ display: 'block' }}>{templates?.filter(t => t.floor === f.key).map(t => t.name).join(', ')}</span>
              </span>
              <Button small variant="primary" disabled={busy} onClick={() => go(f.key)}>Open</Button>
            </li>
          ))}
        </ul>
        <ErrorText error={error} />
      </div>
    </Sheet>
  )
}
