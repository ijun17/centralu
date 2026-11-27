import { useEffect, useRef, useState } from 'react'
import { ShellBanner } from '@cc/ui'
import type { RpcClient } from '@cc/platform/web'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Random 6-char pairing code (`XXX-XXX`) shown in both this browser tab and the desktop approval card */
function makePairingCode(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length] ?? 'A')
  return `${chars.slice(0, 3).join('')}-${chars.slice(3).join('')}`
}

/**
 * Shown only in `apps/web` (`pnpm dev:live`) when connected with the limited credential.
 * Lets the person approve this open browser tab once in the real Centralu desktop window
 * so messages sent from here are recorded as typed by the person rather than as a script.
 * Trust lives only in memory on the host for this open WebSocket and resets automatically
 * on disconnect or page reload.
 */
export function DevTrustBanner({ rpc }: { rpc: RpcClient }) {
  const [limited, setLimited] = useState(() => rpc.connectionState === 'connected' && rpc.rights === 'limited')
  const [trusted, setTrusted] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [pendingCode, setPendingCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reqGenRef = useRef(0)

  useEffect(() => {
    const reset = (isLimited: boolean) => {
      reqGenRef.current += 1
      setLimited(isLimited)
      // Trust is bound strictly to one open WebSocket; clear local state on disconnect/reconnect
      setTrusted(false)
      setPendingCode(null)
      setError(null)
    }
    const isConnected = rpc.connectionState === 'connected'
    if (isConnected) setLimited(rpc.rights === 'limited')
    else reset(false)

    const off = rpc.onConnectionChange((state) => {
      if (state === 'disconnected' || state === 'connecting') {
        reset(false)
        return
      }
      if (state === 'connected') {
        reset(rpc.rights === 'limited')
      }
    })
    return () => {
      reqGenRef.current += 1
      off()
    }
  }, [rpc])

  if (!limited || trusted || dismissed) return null

  const requestTrust = () => {
    if (pendingCode || rpc.connectionState !== 'connected' || rpc.rights !== 'limited') return
    const gen = ++reqGenRef.current
    const code = makePairingCode()
    setPendingCode(code)
    setError(null)
    void rpc
      .call('host.trustDevTab', { code })
      .then(() => {
        if (reqGenRef.current !== gen) return
        setTrusted(true)
        setPendingCode(null)
      })
      .catch((err: unknown) => {
        if (reqGenRef.current !== gen) return
        setPendingCode(null)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <ShellBanner testId="dev-trust-banner" role="status">
      {pendingCode ? (
        <span className="min-w-0 flex-1 truncate" data-testid="dev-trust-pending">
          Confirm code <strong className="font-mono text-ink">{pendingCode}</strong> in the Centralu desktop window to send messages as you…
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">
          Dev preview (limited): messages sent from this tab are tagged as a script.
        </span>
      )}
      {error && (
        <span className="min-w-0 max-w-[40%] truncate text-danger" title={error} data-testid="dev-trust-error">
          {error}
        </span>
      )}
      {!pendingCode && (
        <>
          <button
            className="shrink-0 rounded-md border border-line px-2 py-0.5 text-ink hover:border-line-strong"
            onClick={requestTrust}
            data-testid="dev-trust-button"
          >
            {error ? 'Try again' : 'Trust this tab'}
          </button>
          <button
            className="shrink-0 text-ink-faint hover:text-ink"
            onClick={() => setDismissed(true)}
            data-testid="dev-trust-dismiss"
          >
            Dismiss
          </button>
        </>
      )}
    </ShellBanner>
  )
}
