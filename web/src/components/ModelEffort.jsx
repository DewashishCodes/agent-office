import { useState } from 'react'
import { api } from '../api.js'
import { clawdUrl } from '../clawd.js'
import { ErrorText, useAction } from '../ui.jsx'

const MODELS = ['haiku', 'sonnet', 'opus']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// Saves on change. A run already going keeps the flags it started with; the next run uses the new ones.
export default function ModelEffort({ a, onSaved }) {
  const [run, busy, error] = useAction()
  const [v, setV] = useState({ model: a.model, effort: a.effort })
  const [switching, setSwitching] = useState(false)
  const save = (k, x) => {
    setV(s => ({ ...s, [k]: x }))
    run(async () => {
      await api(`/agents/${a.id}`, { method: 'PATCH', body: { [k]: x } })
      if (k === 'model') { setSwitching(true); setTimeout(() => setSwitching(false), 2500) }
      onSaved?.()
    })
  }
  const opts = (list, cur) => (list.includes(cur) ? list : [...list, cur]).map(x => <option key={x}>{x}</option>)
  const set = switching ? 'model-switch' : `effort-${EFFORTS.includes(v.effort) ? v.effort : 'medium'}`
  return (
    <div className="model-effort">
      <img src={clawdUrl(set)} alt="" />
      <label className="field"><span>Model</span>
        <select value={v.model} disabled={busy} onChange={e => save('model', e.target.value)}>{opts(MODELS, v.model)}</select>
      </label>
      <label className="field"><span>Effort</span>
        <select value={v.effort} disabled={busy} onChange={e => save('effort', e.target.value)}>{opts(EFFORTS, v.effort)}</select>
      </label>
      <ErrorText error={error} />
    </div>
  )
}
