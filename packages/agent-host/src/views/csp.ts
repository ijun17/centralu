import { isIP } from 'node:net'
import { isThisMachineHost } from '../this-machine.js'

/**
 * The CSP for an app view: it reaches only what the app declared in `_meta.ui.csp`; with no declaration the spec's (SEP-1865)
 * restrictive default applies (`connect-src 'none'`, no outside resources, no nested frames), not ext-apps' `connect-src
 * 'self'`, as our 'self' is the host's loopback port. Under the opaque-origin method the string is the header of the proxy
 * page, which a srcdoc document inherits, so that response alone decides the policy; a view's own `<meta>` can tighten it but
 * never widen it
 */

export type ViewCspDomains = {
  connectDomains?: string[]
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}

export type ViewPermissions = {
  camera?: object
  microphone?: object
  geolocation?: object
  clipboardWrite?: object
}

/**
 * The shape a declaration must have: only `scheme://host[:port][/path]`. Every broader shape the CSP grammar allows is
 * rejected: `*`, `https:`, `data:` (everything or a whole scheme), a keyword like `'unsafe-eval'` (changes the policy), a value
 * with whitespace, `;` or `,` (smuggles a directive). This machine (`isThisMachineHost`: `localhost`, `127.0.0.0/8`,
 * `0.0.0.0/8`, link-local `169.254.0.0/16`, the list an https import is refused for) is rejected too: those addresses hold the
 * routes behind the host's secret path and other apps' per-app origin ports. An IPv6 literal never gets here, as the pattern
 * has no brackets. An app that needs a local service goes through its app server
 */
const SOURCE = /^(https?|wss?):\/\/(\*\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::(\d{1,5}|\*))?(\/[a-z0-9._~%/-]*)?$/i

/**
 * CSP and the browser consume a WHATWG URL, so the security decision uses that canonical host: numeric IPv4 has several legal
 * spellings (`127.1`, an integer, octal, hex) that URL parsing turns into a dotted address
 */
function canonicalSource(source: string): string | null {
  const match = SOURCE.exec(source)
  if (!match) return null
  const [, rawScheme, wildcard = '', rawHost, rawPort, rawPath = ''] = match
  if (!rawScheme || !rawHost) return null

  const scheme = rawScheme.toLowerCase()
  const probePort = rawPort === '*' ? '1' : rawPort
  let parsed: URL
  try {
    parsed = new URL(`${scheme}://${rawHost}${probePort ? `:${probePort}` : ''}${rawPath}`)
  } catch {
    return null
  }

  const host = parsed.hostname.toLowerCase()
  if (isThisMachineHost(host) || (wildcard && isIP(host) !== 0)) return null

  const port = rawPort ? `:${rawPort === '*' ? '*' : Number(rawPort)}` : ''
  const path = rawPath ? parsed.pathname : ''
  return `${scheme}://${wildcard}${host}${port}${path}`
}

export function sanitizeDomains(list: unknown): { kept: string[]; dropped: string[] } {
  const kept: string[] = []
  const dropped: string[] = []
  if (!Array.isArray(list)) return { kept, dropped }
  for (const item of list) {
    const canonical = typeof item === 'string' ? canonicalSource(item) : null
    if (canonical) {
      if (!kept.includes(canonical)) kept.push(canonical)
      continue
    }
    dropped.push(typeof item === 'string' ? item : JSON.stringify(item))
  }
  return { kept, dropped }
}

export type ApprovedCsp = {
  policy: string
  approved: Required<ViewCspDomains>
  dropped: string[]
}

/**
 * A view's CSP: `default-src 'none'`; script and style `'unsafe-inline'` (a view is inline HTML, as the spec's default);
 * img/media/font `data:` and `blob:` (created inside the page); connect and frame `'none'` until declared (under the opaque
 * method `frame-src` also stops the view navigating its own frame outward, see `buildProxyCsp`); `form-action 'none'` (a form
 * submission bypasses connect-src); `object-src 'none'`; `base-uri 'self'`. 'self' is in no resource directive, as under opaque
 * origin it is the proxy's own origin and holds nothing for a view; 'unsafe-eval' is not in the spec's default, and the
 * official example app ran without it (spike S-1)
 */
export function buildViewCsp(csp: ViewCspDomains | undefined): ApprovedCsp {
  const connect = sanitizeDomains(csp?.connectDomains)
  const resource = sanitizeDomains(csp?.resourceDomains)
  const frame = sanitizeDomains(csp?.frameDomains)
  const base = sanitizeDomains(csp?.baseUriDomains)
  const r = resource.kept.join(' ')
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ')
  const policy = [
    "default-src 'none'",
    `script-src ${join("'unsafe-inline'", r)}`,
    `style-src ${join("'unsafe-inline'", r)}`,
    `img-src ${join('data: blob:', r)}`,
    `font-src ${join('data:', r)}`,
    `media-src ${join('data: blob:', r)}`,
    `worker-src ${join('blob:', r)}`,
    `connect-src ${connect.kept.length ? connect.kept.join(' ') : "'none'"}`,
    `frame-src ${frame.kept.length ? frame.kept.join(' ') : "'none'"}`,
    "form-action 'none'",
    "object-src 'none'",
    `base-uri ${base.kept.length ? base.kept.join(' ') : "'self'"}`,
  ].join('; ')
  return {
    policy,
    approved: {
      connectDomains: connect.kept,
      resourceDomains: resource.kept,
      frameDomains: frame.kept,
      baseUriDomains: base.kept,
    },
    dropped: [...connect.dropped, ...resource.dropped, ...frame.dropped, ...base.dropped],
  }
}

/**
 * The proxy page's CSP under the per-app origin method: the view comes from its own port, so the proxy needs only its one
 * inline script (pinned by hash) and a frame to that origin. Its `frame-src` is what blocks a view from sending its own frame
 * elsewhere to leak data (`location = 'https://…?data'`): a frame's navigation is checked against the `frame-src` of the
 * document embedding it, never the view's own policy (`buildViewCsp`). Loosening the view's `frame-src` here changes nothing;
 * loosening this one lets the navigation out. Under the opaque method there is no separate proxy policy, so `buildViewCsp`'s
 * `frame-src` does the job. `e2e/app-frame.spec.ts` ("which CSP stops a frame navigating itself outward") shows both
 */
export function buildProxyCsp(scriptHash: string, appOrigin: string): string {
  return [
    "default-src 'none'",
    `script-src '${scriptHash}'`,
    "style-src 'unsafe-inline'",
    `frame-src ${appOrigin}`,
    "form-action 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/**
 * The iframe `allow` attribute: only the features the app declared, in ext-apps' `buildAllowAttribute` order and names (camera,
 * microphone, location, clipboard write); an unrecognized key is dropped
 */
export function allowAttribute(permissions: ViewPermissions | undefined): string {
  if (!permissions || typeof permissions !== 'object') return ''
  const out: string[] = []
  if (permissions.camera) out.push('camera')
  if (permissions.microphone) out.push('microphone')
  if (permissions.geolocation) out.push('geolocation')
  if (permissions.clipboardWrite) out.push('clipboard-write')
  return out.join('; ')
}

export function approvedPermissions(permissions: ViewPermissions | undefined): ViewPermissions {
  const out: ViewPermissions = {}
  if (!permissions || typeof permissions !== 'object') return out
  if (permissions.camera) out.camera = {}
  if (permissions.microphone) out.microphone = {}
  if (permissions.geolocation) out.geolocation = {}
  if (permissions.clipboardWrite) out.clipboardWrite = {}
  return out
}
