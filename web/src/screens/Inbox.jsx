import { useEffect, useState } from 'react'
import { api, on, useData } from '../api.js'
import { Badge, Button, ConfirmButton, Empty, ErrorText, ago, useAction } from '../ui.jsx'

export default function Inbox({ pid }) {
  const [all, setAll] = useState(false)
  const [items, , error] = useData(`/projects/${pid}/inbox${all ? '' : '?status=open'}`, on(pid, 'inbox'))
  return (
    <section className="page stack">
      <div className="row wrap">
        <h1 className="grow">Inbox</h1>
        <PushButton />
      </div>
      <label className="check">
        <input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Show resolved items
      </label>
      <ErrorText error={error} />
      {items?.length === 0 && <Empty>{all ? 'Nothing here yet.' : 'All clear. Nothing needs you right now.'}</Empty>}
      <ul className="list">{items?.map(i => <Item key={i.id} i={i} />)}</ul>
    </section>
  )
}

const KIND = { plan: 'Plan to approve', merge: 'Ready to merge', question: 'Question', failure: 'Failure' }

function Item({ i }) {
  const [text, setText] = useState('')
  const [revising, setRevising] = useState(false)
  const [run, busy, error] = useAction()
  const act = (action, extra) => run(() => api(`/inbox/${i.id}/action`, { method: 'POST', body: { action, ...extra } }))
  const open = i.status === 'open'

  return (
    <li className={`card inbox-item ${open ? '' : 'resolved'}`}>
      <div className="row wrap">
        <Badge status={i.kind}>{KIND[i.kind] || i.kind}</Badge>
        <span className="muted small grow">{ago(i.created_at)}{!open && ', resolved'}</span>
        {i.link && <a className="small" href={i.link} target="_blank" rel="noreferrer">Open on GitHub</a>}
      </div>
      <h3>{i.title}</h3>
      {i.body && <p className="pre small">{i.body}</p>}
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
      {open && i.kind === 'merge' && (
        <div className="actions">
          <ConfirmButton variant="primary" confirm="Squash and merge" disabled={busy} onConfirm={() => act('merge')}>Merge</ConfirmButton>
          <Button variant="ghost" disabled={busy} onClick={() => act('dismiss')}>Dismiss</Button>
        </div>
      )}
      {open && i.kind === 'failure' && (
        <div className="actions">
          <Button variant="primary" disabled={busy} onClick={() => act('retry')}>Retry</Button>
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

function PushButton() {
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
