import { isIP } from 'node:net'
import { isThisMachineHost } from '../this-machine.js'

/**
 * The CSP for an app view (M4 B-3).
 *
 * A view is HTML given by the app, and it can reach **only what the app declared** in
 * `_meta.ui.csp`. With no declaration, the spec's (SEP-1865) restrictive default is used: network
 * is `connect-src 'none'`, and there are no outside resources and no nested frames. The reference
 * host (ext-apps basic-host) defaults to `connect-src 'self'`; ours does not follow that default
 * because our 'self' is the host's loopback port.
 *
 * Under the opaque-origin method, this string goes out as the header of the **proxy page**. Since
 * a srcdoc document inherits its parent's policy, the proxy page's response is the one and only
 * place that decides the view's policy. The view can tighten its CSP further with its own
 * `<meta>`, but it can never widen it beyond this.
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
 * The shape a single declaration must have to be accepted. Only `scheme://host[:port][/path]` is
 * accepted.
 *
 * The spec says only "domain," so every broader shape the CSP grammar itself allows is rejected:
 *   `*`, `https:`, `data:`               not an origin at all — either everything or a whole scheme
 *   a keyword like `'unsafe-eval'`       a way to change the policy through a domain declaration
 *   a value with whitespace, `;`, `,`    a way to smuggle in an extra directive
 *
 * This machine (`isThisMachineHost`: `localhost`, `127.0.0.0/8`, `0.0.0.0/8`, and link-local `169.254.0.0/16`, the same
 * list an https import is refused for) is also rejected. Those addresses hold the routes behind the host's secret
 * path, and other apps' per-app origin ports. A view has no reason to reach any of that. An IPv6 literal cannot get
 * this far at all: the pattern above has no brackets, so `[::1]` is dropped by it, not by that check. An app that needs
 * to talk to a local service does so through the app server instead (this design's principle of keeping state and outbound calls on the server).
 */
const SOURCE = /^(https?|wss?):\/\/(\*\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::(\d{1,5}|\*))?(\/[a-z0-9._~%/-]*)?$/i

/**
 * CSP and the browser consume a WHATWG URL, so the security decision must use that same canonical
 * host. Numeric IPv4 has several legal spellings (`127.1`, an integer, octal and hexadecimal), all
 * of which URL parsing turns into a dotted address before a request is made.
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

/** Splits a declaration list. Only what is accepted goes into the policy; what is dropped is recorded in the host log */
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
  /** The policy string (used as is in the response header) */
  policy: string
  /** Accepted declarations — reported to the view as what the host approved (`hostCapabilities.sandbox.csp`) */
  approved: Required<ViewCspDomains>
  /** Dropped declarations — recorded in the log as the answer to "why isn't this image showing up" */
  dropped: string[]
}

/**
 * A view's CSP.
 *
 *   default-src 'none'            everything not listed is blocked
 *   script/style 'unsafe-inline'  a view is inline HTML (matches the spec's default)
 *   img/media/font data:, blob:   data created inside the page, so not network traffic
 *   connect/frame 'none'          opens to those origins only when declared. Under the opaque method this
 *                                `frame-src` is also what stops the view navigating its own frame outward
 *                                (see `buildProxyCsp` for the per-app origin method)
 *   form-action 'none'            form submission is a leak path that bypasses connect-src
 *   object-src 'none'
 *   base-uri 'self'               the spec's default
 *
 * 'self' is not put in a resource directive. Under opaque origin, 'self' refers to the proxy's own
 * origin (the host port), and there is nothing there for a view to use. 'unsafe-eval' is not added
 * either (it is not in the spec's default). In S-1, the official example app ran fine under this
 * condition.
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
 * The **proxy page**'s CSP under the per-app origin method. In this case, the view comes from its
 * own port rather than from the proxy, so the proxy itself needs only its one inline script
 * (pinned by hash) and a frame to that one origin.
 *
 * `frame-src` also decides **where the proxy's child frame is allowed to go.** This is what blocks
 * a view from sending its own frame elsewhere to leak data (`location = 'https://…?data'`): a
 * frame's navigation is checked against the `frame-src` of the document that embeds it, here this
 * page, never against the view's own policy (`buildViewCsp`, whose `frame-src` governs only the
 * frames the view creates). Loosening the view's `frame-src` in this mode changes nothing; loosening
 * this one lets the navigation out. Under the opaque method there is no separate proxy policy: the
 * proxy page's header is the view's policy, so the `frame-src` of `buildViewCsp` (only what was
 * declared) is the one that does this job. Both are shown by loosening the real response headers in
 * `e2e/app-frame.spec.ts` ("which CSP stops a frame navigating itself outward").
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
 * The iframe `allow` attribute — passes through only the features the app declared. Same order
 * and names as ext-apps' `buildAllowAttribute` (camera, microphone, location, clipboard write).
 * An unrecognized key is dropped.
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

/** Returns only the accepted permissions (`hostCapabilities.sandbox.permissions`) */
export function approvedPermissions(permissions: ViewPermissions | undefined): ViewPermissions {
  const out: ViewPermissions = {}
  if (!permissions || typeof permissions !== 'object') return out
  if (permissions.camera) out.camera = {}
  if (permissions.microphone) out.microphone = {}
  if (permissions.geolocation) out.geolocation = {}
  if (permissions.clipboardWrite) out.clipboardWrite = {}
  return out
}
