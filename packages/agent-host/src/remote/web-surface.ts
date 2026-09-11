import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { wireSegments, type RemoteHostInfo } from '@cc/protocol'
import type { HostHttpHandler, HostHttpResponse } from '../transport/server.js'

export type RemoteWebOptions = Readonly<{ root: string; token: string; hostLabel: string }>
type RemoteWebRequest = Readonly<{
  method: string
  path: string
  host: string | null
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
}>
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
}
const NO_STORE_HEADERS: Readonly<Record<string, string>> = { ...SECURITY_HEADERS, 'cache-control': 'no-store' }
const ASSET_HEADERS: Readonly<Record<string, string>> = { ...SECURITY_HEADERS, 'cache-control': 'public, max-age=31536000, immutable' }

export function createRemoteWebSurface(options: RemoteWebOptions): { onHttp: HostHttpHandler; allowUpgrade: (request: IncomingMessage) => boolean } {
  const root = realpathSync(options.root)
  const tokenDigest = digest(options.token)
  return {
    onHttp: (path, request) => {
      if (hasTraversal((request.url ?? '/').split('?')[0] ?? '/')) return text(403, 'forbidden')
      return handle({ method: request.method ?? 'GET', path, host: headerValue(request.headers.host), headers: request.headers }, root, tokenDigest, options.hostLabel)
    },
    allowUpgrade: (request) => isLoopbackRequest(request.headers),
  }
}

function handle(request: RemoteWebRequest, root: string, tokenDigest: Buffer, label: string): HostHttpResponse | null {
  if (!isLoopbackHost(request.host) || !sameOrigin(request.headers.origin, request.host)) return text(403, 'forbidden')
  if (hasTraversal(request.path)) return text(403, 'forbidden')
  if (request.path === '/centralu-info.json') return info(request, label)
  if (request.path === '/centralu-auth') return auth(request, tokenDigest)
  const hit = staticFile(request, root)
  return hit
}

function info(request: RemoteWebRequest, hostLabel: string): HostHttpResponse {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
  return json(200, request.method === 'HEAD' ? '' : JSON.stringify({ mode: 'remote', hostLabel } satisfies RemoteHostInfo))
}

function auth(request: RemoteWebRequest, tokenDigest: Buffer): HostHttpResponse {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  return response(tokenOk(headerValue(request.headers.authorization), tokenDigest) ? 204 : 401, 'text/plain; charset=utf-8', '', NO_STORE_HEADERS)
}

function staticFile(request: RemoteWebRequest, root: string): HostHttpResponse | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
  const asset = resolveAsset(root, request.path)
  if (asset.kind === 'missing') return null
  if (asset.kind === 'forbidden') return text(403, 'forbidden')
  try {
    const body = request.method === 'HEAD' ? Buffer.alloc(0) : readFileSync(asset.path)
    return response(200, contentType(asset.path), body, isHtml(asset.path) ? NO_STORE_HEADERS : ASSET_HEADERS)
  } catch { return text(404, 'not found') }
}

type Asset = Readonly<{ kind: 'ok'; path: string }> | Readonly<{ kind: 'missing' }> | Readonly<{ kind: 'forbidden' }>

function resolveAsset(root: string, requestPath: string): Asset {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return { kind: 'forbidden' }
  }
  const parts = decoded === '/' ? ['index.html'] : wireSegments(decoded).filter((part) => part.length > 0)
  if (parts.some((part) => part === '..' || part.includes('\\') || hasControlCharacter(part))) return { kind: 'forbidden' }
  const candidate = join(root, ...parts)
  if (!existsSync(candidate)) return { kind: 'missing' }
  let real: string
  try {
    real = realpathSync(candidate)
  } catch {
    return { kind: 'missing' }
  }
  if (!inside(root, real)) return { kind: 'forbidden' }
  try {
    if (!statSync(real).isFile()) return { kind: 'missing' }
  } catch {
    return { kind: 'missing' }
  }
  return { kind: 'ok', path: real }
}

function hasTraversal(path: string): boolean {
  try {
    return wireSegments(decodeURIComponent(path)).some((part) => part === '..')
  } catch {
    return true
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..')
}

function isLoopbackRequest(headers: Readonly<Record<string, string | readonly string[] | undefined>>): boolean {
  const host = headerValue(headers.host)
  return isLoopbackHost(host) && sameOrigin(headers.origin, host)
}

function isLoopbackHost(host: string | null): boolean {
  if (host === null) return false
  const parsed = splitHost(host)
  return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || parsed.hostname === '::1'
}

function sameOrigin(origin: string | readonly string[] | undefined, host: string | null): boolean {
  const value = headerValue(origin)
  if (value === null) return true
  if (host === null) return false
  try {
    const parsed = new URL(value)
    const expected = splitHost(host)
    const actual = splitHost(parsed.host)
    return (parsed.protocol === 'http:' || parsed.protocol === 'ws:') && actual.hostname === expected.hostname && actual.port === expected.port
  } catch {
    return false
  }
}

function splitHost(value: string): Readonly<{ hostname: string; port: string }> {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    const hostname = end >= 0 ? value.slice(0, end + 1).toLowerCase() : value.toLowerCase()
    const port = end >= 0 && value.slice(end + 1).startsWith(':') ? value.slice(end + 2) : ''
    return { hostname, port }
  }
  const lastColon = value.lastIndexOf(':')
  if (lastColon > -1 && value.indexOf(':') === lastColon) return { hostname: value.slice(0, lastColon).toLowerCase(), port: value.slice(lastColon + 1) }
  return { hostname: value.toLowerCase(), port: '' }
}

function headerValue(value: string | readonly string[] | undefined): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? null
  return null
}

function tokenOk(authorization: string | null, expectedDigest: Buffer): boolean {
  if (authorization === null || !authorization.startsWith('Bearer ')) return false
  const actualDigest = digest(authorization.slice('Bearer '.length))
  return actualDigest.length === expectedDigest.length && timingSafeEqual(actualDigest, expectedDigest)
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

function methodNotAllowed(allow: string): HostHttpResponse {
  return response(405, 'text/plain; charset=utf-8', 'method not allowed', { ...NO_STORE_HEADERS, allow })
}

function json(status: number, body: string): HostHttpResponse {
  return response(status, 'application/json; charset=utf-8', body, NO_STORE_HEADERS)
}

function text(status: number, body: string): HostHttpResponse {
  return response(status, 'text/plain; charset=utf-8', body, NO_STORE_HEADERS)
}

function response(status: number, contentType: string, body: string | Buffer, headers: Readonly<Record<string, string>>): HostHttpResponse {
  return { status, contentType, body, headers: { ...headers, 'content-type': contentType } }
}

function isHtml(path: string): boolean {
  return extname(path).toLowerCase() === '.html'
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.mjs': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.ico': return 'image/x-icon'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}
