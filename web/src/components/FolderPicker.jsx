import { useData } from '../api.js'
import { ErrorText } from '../ui.jsx'

// Browses folders on the crew PC (GET /api/fs/dirs). path null = the start list: home folder and drives.
export default function FolderPicker({ path, onPath }) {
  const [d, , error] = useData(`/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`)
  const sep = path?.includes('\\') ? '\\' : '/'
  const child = name => d?.path ? `${d.path.replace(/[\\/]+$/, '')}${sep}${name}` : name
  return (
    <div className="folder-picker">
      <div className="fp-head">
        <button type="button" className="btn small ghost" disabled={!path} onClick={() => onPath(d?.parent ?? null)} aria-label="Up one folder">Up</button>
        <span className="mono small clip" title={path || ''}>{path || 'Choose a starting point'}</span>
      </div>
      <ErrorText error={error} />
      <ul className="fp-list">
        {d?.dirs.map(name => (
          <li key={name}><button type="button" onClick={() => onPath(child(name))}><span aria-hidden="true">&#128193;</span> {name}</button></li>
        ))}
        {d && !d.dirs.length && <li className="muted small">No folders inside</li>}
      </ul>
    </div>
  )
}
