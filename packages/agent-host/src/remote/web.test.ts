import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { createRemoteWebSurface } from './web-surface.js'

const dirs: string[] = []
function dist(): string {
  const root = mkdtempSync(join(tmpdir(), 'centralu-remote-web-'))
  dirs.push(root)
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'index.html'), '<div id="root"></div><script src="/assets/app.abc123.js"></script>')
  writeFileSync(join(root, 'assets', 'app.abc123.js'), 'console.log("app")')
  writeFileSync(join(root, 'assets', 'app.abc123.css'), 'body{}')
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function req(path: string, method = 'GET', host = '127.0.0.1:55175', authorization?: string): IncomingMessage {
  const request = new IncomingMessage(new Socket())
  request.method = method
  request.url = path
  request.headers = { host, authorization }
  return request
}
function createHandler(options: Parameters<typeof createRemoteWebSurface>[0]) {
  const surface = createRemoteWebSurface(options)
  return (request: IncomingMessage) => surface.onHttp(request.url ?? '/', request) ?? { status: 404 }
}

describe('remote web handler', () => {
  it('serves index/assets/info with security headers and no token', () => {
    const handler = createHandler({ root: dist(), token: 'remote-test-token', hostLabel: 'node-a' })
    const page = handler(req('/'))
    const script = handler(req('/assets/app.abc123.js'))
    const style = handler(req('/assets/app.abc123.css'))
    const info = handler(req('/centralu-info.json'))
    expect(page).toMatchObject({ status: 200, headers: expect.objectContaining({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }) })
    expect(String(page?.body)).not.toContain('remote-test-token')
    expect(script?.headers?.['content-type']).toContain('text/javascript')
    expect(style?.headers?.['content-type']).toContain('text/css')
    expect(info).toMatchObject({ status: 200, body: '{"mode":"remote","hostLabel":"node-a"}' })
  })

  it('authenticates only POST bearer tokens and never returns the token', () => {
    const handler = createHandler({ root: dist(), token: 'remote-test-token', hostLabel: 'node-a' })
    expect(handler(req('/centralu-auth', 'GET'))?.status).toBe(405)
    expect(handler(req('/centralu-auth', 'POST'))?.status).toBe(401)
    expect(handler(req('/centralu-auth', 'POST', '127.0.0.1', 'Bearer wrong'))?.status).toBe(401)
    const ok = handler(req('/centralu-auth', 'POST', '127.0.0.1', 'Bearer remote-test-token'))
    expect(ok).toMatchObject({ status: 204 })
    expect(String(ok?.body ?? '')).not.toContain('remote-test-token')
  })

  it('rejects unsupported methods, hostile hosts, traversal, and symlink escapes', () => {
    const root = dist()
    const outside = mkdtempSync(join(tmpdir(), 'centralu-outside-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'assets', 'escape.txt'))
    const handler = createHandler({ root, token: 'remote-test-token', hostLabel: 'node-a' })
    expect(handler(req('/assets/app.abc123.js', 'POST'))?.status).toBe(405)
    expect(handler(req('/', 'GET', 'attacker.example'))?.status).toBe(403)
    expect(handler(req('/%2e%2e/package.json'))?.status).toBe(403)
    expect(handler(req('/assets/escape.txt'))?.status).toBe(403)
    expect(handler(req('/missing.js'))?.status).toBe(404)
  })
})
