import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The desktop window's CSP (M4 B-3b, spike S-1).
 *
 * An app screen is opened as an iframe pointed at the loopback sandbox proxy
 * (`http://127.0.0.1:<host port>`). The original CSP had no `frame-src`, so it fell back to
 * `default-src 'self'`, and the proxy frame was blocked (measured in S-1). The port cannot be
 * fixed — the host comes up with `--port 0`, so the number changes on every run
 * (sidecar.rs). So `127.0.0.1:*` is opened instead. Every path over that port sits behind a
 * secret slot created fresh on every run (transport/http.ts).
 *
 * **This is not widened beyond this.** Opening `*` or `http:` would let any page, not just an
 * app screen, load inside our window. `localhost` is not opened either — it is the same
 * loopback, but our proxy never builds an address under that name.
 *
 * The permissions half of this (S-2: no `remote` permission exists; our commands are granted
 * only to the local origin of window `main`) is enforced by desktop-permissions.test.ts.
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

function csp(): Map<string, string[]> {
  const conf = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')) as { app: { security: { csp: string } } }
  return new Map(
    conf.app.security.csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name = '', ...values] = d.split(/\s+/)
        return [name, values] as [string, string[]]
      }),
  )
}

describe('desktop CSP', () => {
  it('opens only loopback http for frames — the port changes on every run and cannot be fixed', () => {
    expect(csp().get('frame-src')).toEqual(['http://127.0.0.1:*'])
  })

  it('has no child-src/default-src workaround that widens frames', () => {
    const d = csp()
    expect(d.get('default-src')).toEqual(["'self'"])
    expect(d.has('child-src')).toBe(false)
  })

  it('still loads scripts only from our own screen', () => {
    expect(csp().get('script-src')).toEqual(["'self'"])
  })
})
