import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { App } from '@cc/ui'
import { createWebPlatform } from '@cc/platform/web'
import type { Platform } from '@cc/platform/ports'
import { RemoteHostInfo } from '@cc/protocol'
import './remote-bootstrap.css'

type RemoteState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'metadata_failed'; readonly message: string }
  | { readonly kind: 'auth'; readonly info: RemoteHostInfo }
  | { readonly kind: 'ready'; readonly info: RemoteHostInfo; readonly platform: Platform }

const AUTH_TIMEOUT_MS = 10_000

export function RemoteBootstrap() {
  const [state, setState] = useState<RemoteState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    fetchJson('/centralu-info.json')
      .then((payload) => {
        if (cancelled) return
        const parsed = RemoteHostInfo.safeParse(payload)
        setState(parsed.success
          ? { kind: 'auth', info: parsed.data }
          : { kind: 'metadata_failed', message: 'Remote host metadata was not recognized.' })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({ kind: 'metadata_failed', message: error instanceof Error ? error.message : 'Remote host metadata failed to load.' })
      })
    return () => { cancelled = true }
  }, [attempt])

  useEffect(() => {
    if (state.kind === 'ready') document.title = `CENTRALU · Remote · ${state.info.hostLabel}`
    else document.title = 'CENTRALU · Remote sign in'
  }, [state])

  if (state.kind === 'ready') return <RemoteApp info={state.info} platform={state.platform} />
  if (state.kind === 'metadata_failed') return <RemoteShell message={state.message} onRetry={() => setAttempt((value) => value + 1)} />
  if (state.kind === 'auth') return <RemoteAuth info={state.info} onReady={(platform) => setState({ kind: 'ready', info: state.info, platform })} />
  return <RemoteShell message="Contacting the loopback Agent Host…" />
}

function RemoteApp({ info, platform }: { readonly info: RemoteHostInfo; readonly platform: Platform }) {
  return (
    <div className="remote-app-shell" data-testid="remote-app-shell">
      <div className="remote-top-strip" data-testid="remote-topbar-label" title={`Remote · ${info.hostLabel}`}>
        <span>REMOTE</span>
        <strong>{info.hostLabel}</strong>
      </div>
      <div className="remote-app-slot">
        <App platform={platform} />
      </div>
    </div>
  )
}

function RemoteAuth({ info, onReady }: { readonly info: RemoteHostInfo; readonly onReady: (platform: Platform) => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const disabled = pending || token.length === 0
  const wsUrl = useMemo(() => websocketUrlFromLocation(window.location), [])

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (disabled) return
    const acceptedToken = token
    setPending(true)
    setError(null)
    try {
      const response = await fetchWithTimeout('/centralu-auth', {
        method: 'POST',
        headers: { Authorization: `Bearer ${acceptedToken}` },
      })
      if (response.status === 204) {
        setToken('')
        onReady(createWebPlatform({ hostUrl: wsUrl, token: acceptedToken }))
        return
      }
      setError(response.status === 401 ? `Token rejected by ${info.hostLabel}` : `Remote auth failed with HTTP ${response.status}.`)
    } catch (authError: unknown) {
      setError(authError instanceof Error ? authError.message : 'Remote auth failed.')
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="remote-gate" data-testid="remote-gate">
      <section className="remote-card" aria-labelledby="remote-title">
        <p className="remote-kicker">Remote</p>
        <h1 id="remote-title">CENTRALU</h1>
        <p className="remote-host" data-testid="remote-host-label">{info.hostLabel}</p>
        <p className="remote-copy">This browser tab connects to one trusted loopback Agent Host through your SSH tunnel.</p>
        <form className="remote-form" onSubmit={(event) => { void submit(event) }}>
          <label htmlFor="remote-token">Runtime token</label>
          <input
            id="remote-token"
            name="remote-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'remote-error' : 'remote-hint'}
            data-testid="remote-token"
            autoFocus
          />
          <p id="remote-hint" className="remote-hint">The token stays in this tab's memory for the authenticated preflight and WebSocket reconnects; it is not written to browser storage or URLs.</p>
          {error && <p id="remote-error" className="remote-error" role="alert">{error}</p>}
          <button type="submit" disabled={disabled}>{pending ? 'Checking…' : 'Connect'}</button>
        </form>
      </section>
    </main>
  )
}

function RemoteShell({ message, onRetry }: { readonly message: string; readonly onRetry?: () => void }) {
  return (
    <main className="remote-gate" data-testid="remote-gate">
      <section className="remote-card" aria-live="polite">
        <p className="remote-kicker">Remote</p>
        <h1>CENTRALU</h1>
        <p className="remote-copy">{message}</p>
        {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
      </section>
    </main>
  )
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetchWithTimeout(path, { method: 'GET' })
  if (!response.ok) throw new Error(`Remote host metadata failed with HTTP ${response.status}.`)
  return response.json()
}

async function fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS)
  try {
    return await fetch(path, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timer)
  }
}

function websocketUrlFromLocation(current: Location): string {
  const url = new URL(current.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}
