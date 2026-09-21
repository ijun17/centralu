import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { Store } from '../packages/agent-host/src/dev-services/store.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const token = 'isolated-startup-fixture'

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 1500)
  try { await exited } finally { clearTimeout(deadline) }
}

it('--db carries attachment storage into its data directory, not the inherited data root', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'centralu-startup-'))
  const db = join(temp, 'authoritative', 'store.db')
  const wrong = join(temp, 'inherited')
  const home = join(temp, 'home')
  await Promise.all([mkdir(dirname(db)), mkdir(wrong), mkdir(home)])
  const store = new Store(db)
  store.setAppSetting('updates.auto', 'false')
  store.close()
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--db', db,
  ], {
    cwd: root,
    env: { ...process.env, HOME: home, CC_DATA_DIR: wrong, CC_HOST_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let ws: WebSocket | undefined
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout })
      const timer = setTimeout(() => reject(new Error('host startup timed out')), 5000)
      const onExit = () => reject(new Error('host exited before readiness'))
      const cleanup = () => { clearTimeout(timer); lines.close(); child.off('exit', onExit) }
      child.once('error', reject)
      child.once('exit', onExit)
      lines.on('line', (line) => {
        try {
          const ready = JSON.parse(line) as { ready?: boolean; port?: number }
          if (ready.ready && typeof ready.port === 'number') { cleanup(); resolve(ready.port) }
        } catch { /* Non-ready output is not the readiness contract. */ }
      })
      child.once('exit', cleanup)
    })
    child.stderr.resume()
    const socket = ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const saved = await new Promise<{ path: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('attachment RPC timed out')), 3000)
      socket.onopen = () => socket.send(JSON.stringify({ kind: 'hello', token, protocolVersion: 1 }))
      socket.onerror = () => { clearTimeout(timer); reject(new Error('socket error')) }
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as { kind: string; ok?: boolean; result?: { path: string } }
        if (frame.kind === 'hello_ok') socket.send(JSON.stringify({
          kind: 'rpc', id: 'attachment', method: 'attachments.save',
          params: { sessionId: 'fixture', name: 'sample.txt', mime: 'text/plain', dataBase64: Buffer.from('payload').toString('base64') },
        }))
        if (frame.kind === 'res') {
          clearTimeout(timer)
          if (frame.ok && frame.result) resolve(frame.result)
          else reject(new Error('attachment RPC failed'))
        }
      }
    })
    expect(dirname(saved.path)).toBe(join(dirname(db), 'attachments', 'fixture'))
    expect(await readFile(saved.path, 'utf8')).toBe('payload')
    expect(await readdir(wrong)).toEqual([])
  } finally {
    ws?.close()
    await stop(child)
    await rm(temp, { recursive: true, force: true })
  }
}, 15_000)
