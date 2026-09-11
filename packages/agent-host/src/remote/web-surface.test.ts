import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRemoteWebSurface } from './web-surface.js'

const TOKEN = '0123456789abcdef0123456789abcdef'
let tempDir: string | null = null

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

function makeDist() {
  tempDir = mkdtempSync(join(tmpdir(), 'centralu-remote-web-'))
  const root = join(tempDir, 'dist')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<html><script type="module" src="/assets/app-123.js"></script><link rel="stylesheet" href="/assets/app-123.css"></html>')
  writeFileSync(join(root, 'assets', 'app-123.js'), 'console.log("remote")')
  writeFileSync(join(root, 'assets', 'app-123.css'), 'body{color:#111}')
  writeFileSync(join(tempDir, 'secret.txt'), 'secret')
  symlinkSync(join(tempDir, 'secret.txt'), join(root, 'assets', 'escape.txt'))
  return root
}

function makeRequest(method: string, url: string, headers: Readonly<Record<string, string>>): IncomingMessage {
  const request = new IncomingMessage(new Socket())
  request.method = method
  request.url = url
  Object.defineProperty(request, 'headers', { value: { ...headers }, configurable: true })
  return request
}

describe('remote web surface', () => {
  it('serves only same-origin loopback static assets with hardened headers', () => {
    const root = makeDist()
    const surface = createRemoteWebSurface({ root, token: TOKEN, hostLabel: 'node-a' })
    const index = surface.onHttp('/', makeRequest('GET', '/', { host: '127.0.0.1:5175' }))
    expect(index?.status).toBe(200)
    expect(String(index?.body)).toContain('/assets/app-123.js')
    expect(String(index?.body)).not.toContain(TOKEN)
    expect(index?.contentType).toBe('text/html; charset=utf-8')
    expect(index?.headers?.['cache-control']).toBe('no-store')
    expect(index?.headers?.['x-content-type-options']).toBe('nosniff')
    expect(index?.headers?.['referrer-policy']).toBe('no-referrer')
    expect(index?.headers?.['content-security-policy']).toContain("default-src 'self'")
    expect(index?.headers?.['content-security-policy']).toContain('connect-src')

    const js = surface.onHttp('/assets/app-123.js', makeRequest('GET', '/assets/app-123.js', { host: '127.0.0.1:5175', origin: 'http://127.0.0.1:5175' }))
    expect(js?.status).toBe(200)
    expect(js?.contentType).toBe('text/javascript; charset=utf-8')
    expect(String(js?.body)).toBe('console.log("remote")')

    const css = surface.onHttp('/assets/app-123.css', makeRequest('GET', '/assets/app-123.css', { host: 'localhost' }))
    expect(css?.status).toBe(200)
    expect(css?.contentType).toBe('text/css; charset=utf-8')
  })

  it('exposes non-secret host info and timing-safe bearer auth', () => {
    const root = makeDist()
    const surface = createRemoteWebSurface({ root, token: TOKEN, hostLabel: 'node-a' })
    const info = surface.onHttp('/centralu-info.json', makeRequest('GET', '/centralu-info.json', { host: '127.0.0.1:5175' }))
    expect(info?.status).toBe(200)
    expect(JSON.parse(String(info?.body))).toEqual({ mode: 'remote', hostLabel: 'node-a' })
    expect(String(info?.body)).not.toContain(TOKEN)
    expect(info?.headers?.['cache-control']).toBe('no-store')

    const accepted = surface.onHttp('/centralu-auth', makeRequest('POST', '/centralu-auth', { host: '127.0.0.1:5175', authorization: `Bearer ${TOKEN}` }))
    expect(accepted?.status).toBe(204)
    expect(accepted?.body).toBe('')

    const rejected = surface.onHttp('/centralu-auth', makeRequest('POST', '/centralu-auth', { host: '127.0.0.1:5175', authorization: 'Bearer wrong' }))
    expect(rejected?.status).toBe(401)
    expect(String(rejected?.body)).not.toContain(TOKEN)
  })

  it('rejects unsupported methods, hostile hosts, origin mismatches, traversal, and symlink escapes', () => {
    const root = makeDist()
    const surface = createRemoteWebSurface({ root, token: TOKEN, hostLabel: 'node-a' })
    expect(surface.onHttp('/', makeRequest('POST', '/', { host: '127.0.0.1:5175' }))?.status).toBe(405)
    expect(surface.onHttp('/', makeRequest('GET', '/', { host: 'attacker.example' }))?.status).toBe(403)
    expect(surface.onHttp('/', makeRequest('GET', '/', { host: '127.0.0.1:5175', origin: 'http://attacker.example' }))?.status).toBe(403)
    expect(surface.onHttp('/%2e%2e/secret.txt', makeRequest('GET', '/%2e%2e/secret.txt', { host: '127.0.0.1:5175' }))?.status).toBe(403)
    expect(surface.onHttp('/assets/escape.txt', makeRequest('GET', '/assets/escape.txt', { host: '127.0.0.1:5175' }))?.status).toBe(403)
    expect(surface.onHttp('/missing.js', makeRequest('GET', '/missing.js', { host: '127.0.0.1:5175' }))).toBeNull()
    expect(realpathSync(join(tempDir ?? '', 'secret.txt'))).toBeTruthy()
  })

  it('shares the same loopback and origin checks with websocket upgrades', () => {
    const surface = createRemoteWebSurface({ root: makeDist(), token: TOKEN, hostLabel: 'node-a' })
    expect(surface.allowUpgrade(makeRequest('GET', '/', { host: '127.0.0.1:5175', origin: 'http://127.0.0.1:5175' }))).toBe(true)
    expect(surface.allowUpgrade(makeRequest('GET', '/', { host: '127.0.0.1:5175' }))).toBe(true)
    expect(surface.allowUpgrade(makeRequest('GET', '/', { host: 'attacker.example', origin: 'http://attacker.example' }))).toBe(false)
    expect(surface.allowUpgrade(makeRequest('GET', '/', { host: '127.0.0.1:5175', origin: 'http://attacker.example' }))).toBe(false)
  })

  it('checks the original path before URL normalization and omits HEAD bodies', () => {
    const surface = createRemoteWebSurface({ root: makeDist(), token: TOKEN, hostLabel: 'node-b' })
    expect(surface.onHttp('/', makeRequest('GET', '/assets/../', { host: '127.0.0.1' }))?.status).toBe(403)
    expect(surface.onHttp('/centralu-info.json', makeRequest('HEAD', '/centralu-info.json', { host: '127.0.0.1' }))?.body).toBe('')
  })
})
