import { useState } from 'react'
import { api } from '../api.js'
import { Button, ErrorText, useAction } from '../ui.jsx'

export default function Login({ onDone }) {
  const [token, setToken] = useState('')
  const [run, busy, error] = useAction()
  const submit = e => {
    e.preventDefault()
    run(async () => { await api('/login', { method: 'POST', body: { token } }); onDone() })
  }
  return (
    <main className="login">
      <form className="card stack" onSubmit={submit}>
        <img src="/icon.svg" alt="" width="64" height="64" />
        <h1>Agent Office</h1>
        <label className="field">
          <span>Owner token</span>
          <input type="password" autoComplete="current-password" required value={token} onChange={e => setToken(e.target.value)} autoFocus />
        </label>
        <Button type="submit" variant="primary" disabled={busy || !token}>{busy ? 'Signing in' : 'Sign in'}</Button>
        <ErrorText error={error} />
      </form>
    </main>
  )
}
