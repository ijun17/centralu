import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '@cc/protocol/client'
import { Button, ShellBanner } from '@cc/ui'
import type { RpcClient } from '@cc/platform/web'
import { devTabKey } from './dev-tab-key.js'

/**
 * Shown only in `apps/web` (`pnpm dev:live`) while connected with the limited credential and not trusted: lets the person
 * trust this tab in the Centralu window, so what is sent from here is theirs and not a script's. The code is the host's
 * (`host.devTabCode`), shown here and on the window's card. The trust's key stays in this tab (dev-tab-key.ts) and is
 * presented at every reconnect; one the host no longer takes (expired, taken back in Settings, or a restarted host) is
 * dropped, and this banner offers the trust again (docs/security-boundaries/dev-browser-tabs.md).
 */
export function DevTrustBanner({ rpc }: { rpc: RpcClient }) {
  const [limited, setLimited] = useState(false)
  const [trusted, setTrusted] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [pendingCode, setPendingCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Each connection's own: an answer to a request from an earlier socket changes nothing */
  const reqGenRef = useRef(0)

  useEffect(() => {
    const settle = () => {
      reqGenRef.current += 1
      setPendingCode(null)
      setError(null)
      const connected = rpc.connectionState === 'connected'
      const isLimited = connected && rpc.rights === 'limited'
      setLimited(isLimited)
      setTrusted(isLimited && rpc.trustedDev)
      if (isLimited && !rpc.trustedDev) devTabKey.forget()
    }
    settle()
    const off = rpc.onConnectionChange(settle)
    return () => {
      reqGenRef.current += 1
      off()
    }
  }, [rpc])

  if (!limited || trusted || dismissed) return null

  const requestTrust = async () => {
    if (pendingCode) return
    const gen = ++reqGenRef.current
    setError(null)
    try {
      const { code } = await rpc.call('host.devTabCode', {})
      if (reqGenRef.current !== gen) return
      setPendingCode(code)
      const { key } = await rpc.call('host.trustDevTab', { code })
      if (reqGenRef.current !== gen) return
      if (key) devTabKey.keep(key)
      setTrusted(true)
    } catch (err) {
      if (reqGenRef.current !== gen) return
      setError(errorMessage(err))
    }
    setPendingCode(null)
  }

  return (
    <ShellBanner testId="dev-trust-banner" role="status">
      {pendingCode ? (
        <span className="min-w-0 flex-1 truncate" data-testid="dev-trust-pending">
          Allow it in the Centralu window if it shows the code <strong className="font-mono text-ink">{pendingCode}</strong>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">Dev preview (limited): messages sent from this tab are tagged as a script.</span>
      )}
      {error && (
        <span className="min-w-0 max-w-[40%] truncate text-danger" title={error} data-testid="dev-trust-error">
          {error}
        </span>
      )}
      {!pendingCode && (
        <>
          <Button size="xs" onClick={() => void requestTrust()} data-testid="dev-trust-button">
            {error ? 'Try again' : 'Trust this tab'}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setDismissed(true)} data-testid="dev-trust-dismiss">
            Dismiss
          </Button>
        </>
      )}
    </ShellBanner>
  )
}
