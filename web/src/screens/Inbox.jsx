import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, on, useData } from '../api.js'
import { Badge, Button, ConfirmButton, Empty, ErrorText, ago, useAction } from '../ui.jsx'
import Working from '../components/Working.jsx'
import TaskFacts, { useTask } from '../components/TaskFacts.jsx'
import Permission from '../components/Permission.jsx'
import RetryNote from '../components/RetryNote.jsx'

export default function Inbox({ pid }) {
  const [history, setHistory] = useState(false)
  const [items, , error] = useData(`/projects/${pid}/inbox?status=open`, on(pid, 'inbox'))
  const [done, , doneError] = useData(history && `/projects/${pid}/inbox?status=done`, on(pid, 'inbox'))
  return (
    <section className="page stack">
      <div className="row wrap">
        <h1 className="grow">Needs you</h1>
        <PushButton />
      </div>
      <ErrorText error={error} />
      {items?.length === 0 && <Empty>All clear. Nothing needs you right now.</Empty>}
      <ul className="list">{items?.map(i => <Item key={i.id} i={i} />)}</ul>
      <Button variant="ghost" aria-expanded={history} onClick={() => setHistory(h => !h)}>{history ? 'Hide history' : 'Show history'}</Button>
      {history && (
        <>
          <ErrorText error={doneError} />
          {done?.length === 0 && <Empty>Nothing resolved yet.</Empty>}
          <ul className="list">{done?.map(i => <Item key={i.id} i={i} />)}</ul>
        </>
      )}
    </section>
  )
}

// Merging a whole order resolves its cards one by one, so the card that started it unmounts mid-run.
// The progress lives here and every open card of that order shows it.
const orderMerges = new Map(), subs = new Set()
const setOrderMerge = (id, v) => { v ? orderMerges.set(id, v) : orderMerges.delete(id); subs.forEach(f => f()) }
const subscribe = f => { subs.add(f); return () => subs.delete(f) }

async function mergeOrder(id) {
  setOrderMerge(id, { busy: true })
  try { await api(`/orders/${id}/merge`, { method: 'POST' }); setOrderMerge(id, null) }
  catch (e) { setOrderMerge(id, { error: e.message }) }
}

// Inbox items carry the request input as JSON (cut at 1500 chars); a cut body still shows, as text.
function permissionReq(i) {
  let input
  try { input = JSON.parse(i.body) } catch { return { tool_name: '', input: i.body, summary: i.title } }
  return { tool_name: input?.command ? 'Bash' : '', input, summary: i.title.replace(/^.*? asks to run: /, '') }
}

const KIND = { plan: 'Plan to approve', merge: 'Ready to merge', question: 'Question', failure: 'Failure', permission: 'Permission' }

export function Item({ i }) {
  const [text, setText] = useState('')
  const [revising, setRevising] = useState(false)
  const [merging, setMerging] = useState('')
  const orderMerge = useSyncExternalStore(subscribe, () => orderMerges.get(i.order_id))
  const [run, busy, error] = useAction()
  const act = (action, extra) => run(() => api(`/inbox/${i.id}/action`, { method: 'POST', body: { action, ...extra } }))
  const open = i.status === 'open'
  const [task] = useTask(open && i.kind === 'merge' ? i.task_id : null, i.project_id)
  const red = task?.checks === 'fail'

  return (
    <li className={`card inbox-item ${open ? '' : 'resolved'}`}>
      <div className="row wrap">
        <Badge status={i.kind}>{KIND[i.kind] || i.kind}</Badge>
        <span className="muted small grow">{ago(i.created_at)}{!open && ', resolved'}</span>
        {i.link && <a className="small" href={i.link} target="_blank" rel="noreferrer">Open on GitHub</a>}
      </div>
      <h3>{i.title}</h3>
      {i.body && !(open && i.kind === 'permission') && <p className="pre small">{i.body}</p>}
      {open && i.kind === 'plan' && !revising && (
        <div className="actions">
          <Button variant="primary" disabled={busy} onClick={() => act('approve')}>Approve</Button>
          <Button disabled={busy} onClick={() => setRevising(true)}>Revise</Button>
          <ConfirmButton variant="ghost" confirm="Reject plan" disabled={busy} onConfirm={() => act('reject')}>Reject</ConfirmButton>
          <a className="btn ghost" href="#/command">See plan</a>
        </div>
      )}
      {open && ((i.kind === 'plan' && revising) || i.kind === 'question') && (
        <form className="stack" onSubmit={e => { e.preventDefault(); act(i.kind === 'plan' ? 'revise' : 'answer', { text: text.trim() }) }}>
          <label className="field"><span>{i.kind === 'plan' ? 'What should change' : 'Your answer'}</span>
            <textarea rows="3" value={text} onChange={e => setText(e.target.value)} required />
          </label>
          <div className="actions">
            <Button type="submit" variant="primary" disabled={busy || !text.trim()}>{i.kind === 'plan' ? 'Send feedback' : 'Send answer'}</Button>
            {i.kind === 'plan'
              ? <Button variant="ghost" onClick={() => setRevising(false)}>Cancel</Button>
              : <Button variant="ghost" disabled={busy} onClick={() => act('dismiss')}>Dismiss</Button>}
          </div>
        </form>
      )}
      {open && task && <TaskFacts t={task} />}
      {open && i.kind === 'merge' && (
        <div className="actions">
          <ConfirmButton variant="primary" confirm={red ? 'CI is failing. Merge anyway' : 'Squash and merge'} disabled={busy || orderMerge?.busy} onConfirm={() => { setMerging('Merging. A PR that builds on others is rebased first, so this can take a minute.'); act('merge') }}>Merge</ConfirmButton>
          {i.task_id && i.order_id && (
            <ConfirmButton confirm="Merge every PR of this order, in order" disabled={busy || orderMerge?.busy} onConfirm={() => mergeOrder(i.order_id)}>Merge whole order</ConfirmButton>
          )}
          {task?.conflict === 1 && <Button disabled={busy || orderMerge?.busy} onClick={() => { setMerging(''); act('resolve') }}>Resolve conflicts</Button>}
          <Button variant="ghost" disabled={busy || orderMerge?.busy} onClick={() => { setMerging(''); act('dismiss') }}>Dismiss</Button>
        </div>
      )}
      {open && i.kind === 'merge' && busy && merging && <Working set="git-pr" text={merging} />}
      {open && i.kind === 'merge' && orderMerge?.busy && <Working set="git-pr" text="Merging every PR of this order, one at a time. This can take a few minutes." />}
      {open && i.kind === 'merge' && <ErrorText error={orderMerge?.error} />}
      {open && i.kind === 'permission' && (
        <Permission req={permissionReq(i)} onAnswer={(allow, remember) => api(`/inbox/${i.id}/action`, { method: 'POST', body: { action: allow ? 'allow' : 'deny', remember } })} />
      )}
      {open && i.kind === 'failure' && (
        <div className="actions">
          <Button variant="primary" disabled={busy} onClick={() => act('retry')}>Retry</Button>
          {i.task_id && <RetryNote onRetry={note => api(`/inbox/${i.id}/action`, { method: 'POST', body: { action: 'retry', text: note } })} />}
          <Button variant="ghost" disabled={busy} onClick={() => act('dismiss')}>Dismiss</Button>
        </div>
      )}
      <ErrorText error={error} />
    </li>
  )
}

function urlB64(s) {
  const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(b, c => c.charCodeAt(0))
}

export function PushButton() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const [on, setOn] = useState(false)
  const [run, busy, error] = useAction()
  useEffect(() => {
    if (!supported) return
    navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription()).then(s => setOn(!!s && Notification.permission === 'granted')).catch(() => {})
  }, [supported])
  if (!supported) return null
  if (on) return <span className="muted small">Notifications on</span>
  const enable = () => run(async () => {
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings.')
    const { publicKey } = await api('/push/key')
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(publicKey) })
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } })
    setOn(true)
  })
  return (
    <div>
      <Button small disabled={busy} onClick={enable}>Turn on notifications</Button>
      <ErrorText error={error} />
    </div>
  )
}
