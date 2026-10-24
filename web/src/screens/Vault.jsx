import { useState } from 'react'
import { api, on, useData } from '../api.js'
import { Ago, Button, ConfirmButton, Empty, ErrorText, useAction } from '../ui.jsx'
import { Md } from '../components/Transcript.jsx'

const TABS = [['all', 'Everything'], ['note', 'Notes'], ['decision', 'Decisions'], ['file', 'Files'], ['docs', 'Repo docs']]
const KIND = { note: 'Note', decision: 'Decision', file: 'File' }
const tagList = s => s.split(',').map(t => t.trim()).filter(Boolean)
const size = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`

// Shared context every agent can pull from: owner notes, crew decisions, uploaded files, the repo's crew docs.
export default function Vault({ pid }) {
  const [data, reload, error] = useData(`/projects/${pid}/vault`, on(pid, 'vault'))
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null)
  const items = (data?.items || []).filter(i => (tab === 'all' || i.kind === tab) &&
    (!q || `${i.title} ${i.tags.join(' ')} ${i.snippet}`.toLowerCase().includes(q.toLowerCase())))

  return (
    <section className="page stack vault">
      <a href="#/home" className="back">Back to the office</a>
      <div>
        <h1>Shared context vault</h1>
        <p className="muted small">Agents see the titles in every task prompt and read what the task needs with vault_search and vault_read. They record decisions here with vault_write.</p>
      </div>
      <ErrorText error={error} />
      <div className="grid2">
        <AddNote pid={pid} />
        <Upload pid={pid} onDone={reload} />
      </div>
      <div className="row wrap">
        <div className="seg" role="group" aria-label="Show">
          {TABS.map(([id, name]) => (
            <Button key={id} small variant={tab === id ? 'primary' : 'ghost'} aria-pressed={tab === id} onClick={() => setTab(id)}>{name}</Button>
          ))}
        </div>
        {tab !== 'docs' && <label className="field grow"><span className="sr-only">Filter</span><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by words or tags" /></label>}
      </div>
      {tab === 'docs' ? <Docs pid={pid} docs={data?.docs} /> : (
        data && (items.length ? (
          <ul className="list">
            {items.map(i => <Entry key={i.id} i={i} open={open === i.id} onToggle={() => setOpen(open === i.id ? null : i.id)} />)}
          </ul>
        ) : <Empty>{data.items.length ? 'Nothing matches.' : 'The vault is empty. Add a note or upload a spec, and agents can pull it when a task needs it.'}</Empty>)
      )}
    </section>
  )
}

function AddNote({ pid }) {
  const [f, setF] = useState({ title: '', body: '', tags: '' })
  const [run, busy, error] = useAction()
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }))
  const submit = e => {
    e.preventDefault()
    run(async () => {
      await api(`/projects/${pid}/vault`, { method: 'POST', body: { kind: 'note', title: f.title, body: f.body, tags: tagList(f.tags) } })
      setF({ title: '', body: '', tags: '' })
    })
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Add a note</h2>
      <label className="field"><span>Title</span><input value={f.title} onChange={set('title')} required placeholder="Brand colours and tone" /></label>
      <label className="field"><span>Note</span><textarea rows="4" value={f.body} onChange={set('body')} placeholder="Markdown is fine" /></label>
      <label className="field"><span>Tags (comma separated)</span><input value={f.tags} onChange={set('tags')} placeholder="design, frontend" /></label>
      <div className="actions"><Button type="submit" variant="primary" disabled={busy || !f.title.trim()}>Save note</Button></div>
      <ErrorText error={error} />
    </form>
  )
}

function Upload({ pid, onDone }) {
  const [run, busy, error] = useAction()
  const send = files => run(async () => {
    for (const file of files) {
      const r = await fetch(`/api/projects/${pid}/vault/files?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `Upload failed (${r.status})`)
    }
    onDone()
  })
  return (
    <div className="card stack">
      <h2>Upload files</h2>
      <p className="muted small">Specs, API docs, screenshots, PDFs. Text files are readable through vault_read; images and PDFs by path with the Read tool. Up to 25 MB each.</p>
      <label className={`btn ${busy ? '' : 'primary'} upload`}>
        {busy ? 'Uploading' : 'Choose files'}
        <input type="file" multiple disabled={busy} onChange={e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) send(f) }} />
      </label>
      <ErrorText error={error} />
    </div>
  )
}

function Entry({ i, open, onToggle }) {
  const [full] = useData(open ? `/vault/${i.id}` : null, ev => ev.type === 'vault' && ev.data.id === i.id)
  const [editing, setEditing] = useState(null)
  const [run, busy, error] = useAction()
  const save = () => run(async () => { await api(`/vault/${i.id}`, { method: 'PATCH', body: { title: editing.title, body: editing.body, tags: tagList(editing.tags) } }); setEditing(null) })
  return (
    <li className={`card vault-entry k-${i.kind}`}>
      <button type="button" className="entry-head" onClick={onToggle} aria-expanded={open}>
        <span className="pill">{KIND[i.kind]}</span>
        <span className="grow title clip">{i.title}</span>
        <span className="muted small">{i.author_agent_id ? 'by an agent, ' : ''}<Ago at={i.updated_at} /></span>
      </button>
      {!open && (i.snippet || i.size) ? <p className="muted small clip">{i.snippet || `${i.mime || 'file'}, ${size(i.size)}`}</p> : null}
      {i.tags.length > 0 && <p className="row wrap">{i.tags.map(t => <span key={t} className="pill">{t}</span>)}</p>}
      {open && (
        <div className="stack">
          {editing ? (
            <>
              <label className="field"><span>Title</span><input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} /></label>
              {i.kind !== 'file' && <label className="field"><span>Text</span><textarea rows="8" value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })} /></label>}
              <label className="field"><span>Tags</span><input value={editing.tags} onChange={e => setEditing({ ...editing, tags: e.target.value })} /></label>
              <div className="actions">
                <Button variant="primary" disabled={busy} onClick={save}>Save</Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              </div>
            </>
          ) : (
            <>
              {i.kind === 'file' && /^image\//.test(i.mime || '') && <img className="vault-img" src={`/api/vault/${i.id}/file`} alt={i.title} />}
              {full?.body ? <div className="vault-body pre"><Md text={full.body} /></div> : i.kind !== 'file' && <p className="muted">Loading</p>}
              <div className="actions">
                {i.file && <a className="btn small" href={`/api/vault/${i.id}/file`}>Download</a>}
                <Button small onClick={() => setEditing({ title: i.title, body: full?.body || '', tags: i.tags.join(', ') })}>Edit</Button>
                <ConfirmButton small variant="ghost" confirm="Delete for good" disabled={busy} onConfirm={() => run(() => api(`/vault/${i.id}`, { method: 'DELETE' }))}>Delete</ConfirmButton>
              </div>
            </>
          )}
          <ErrorText error={error} />
        </div>
      )}
    </li>
  )
}

function Docs({ pid, docs }) {
  const [path, setPath] = useState(null)
  const [doc, , error] = useData(path && `/projects/${pid}/vault/doc?path=${encodeURIComponent(path)}`)
  if (!docs) return null
  if (!docs.length) return <Empty>No crew docs in the clone yet. Onboarding writes CLAUDE.md, .crew/PLAYBOOK.md and .crew/owned-paths.json.</Empty>
  return (
    <div className="stack">
      <p className="muted small">Read only: these live in the repo, every task prompt includes them, and changes go through a PR.</p>
      <div className="row wrap">
        {docs.map(d => <Button key={d.path} small variant={path === d.path ? 'primary' : 'default'} onClick={() => setPath(d.path)}>{d.path} <span className="n">{size(d.size)}</span></Button>)}
      </div>
      <ErrorText error={error} />
      {doc && <div className="card vault-body pre mono small">{doc.text}</div>}
    </div>
  )
}
