import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A stand-in for the keeper's child service, speaking its wire protocol (the Rust one is
 * `apps/desktop/src-tauri/src/keeper/children/`, tested there against real processes). It runs real
 * child processes — pipes only, a "pty" is pipes too — and records every request, so a test can say
 * what the host asked for and, as much, what it never asked for.
 *
 * Deliberately simple: output that arrives with no reader attached is buffered and replayed to the
 * next one; there is no line framing and no ring.
 */
export class FakeKeeper {
  readonly dir = mkdtempSync(join(tmpdir(), 'cck-fake-'))
  readonly sock = join(this.dir, 'children.sock')
  /** Every control request, in order: `{op, ...}` */
  readonly requests: Record<string, unknown>[] = []
  /** Attach connections that half-closed (a host detaching) */
  readonly detaches: string[] = []
  private server: Server
  private controls = new Set<Socket>()
  private sockets = new Set<Socket>()
  private closed = false
  private children = new Map<string, { proc: ChildProcess; tag: unknown; kind: string; exit: { code: number | null; signal: number | null } | null; out: Buffer[]; reader: Socket | null }>()
  private next = 1

  private constructor() {
    this.server = createServer((s) => this.onConn(s))
  }

  static async start(): Promise<FakeKeeper> {
    const k = new FakeKeeper()
    await new Promise<void>((r) => k.server.listen(k.sock, r))
    return k
  }

  ops(op: string): Record<string, unknown>[] {
    return this.requests.filter((r) => r.op === op)
  }

  pidOf(id: string): number | undefined {
    return this.children.get(id)?.proc.pid
  }

  alive(id: string): boolean {
    const c = this.children.get(id)
    return !!c && c.exit === null
  }

  /** Spawns a child as if a previous host had asked for it */
  spawnDirect(cmd: string, args: string[], tag: unknown): string {
    return this.spawnChild({ cmd, args, cwd: tmpdir(), env: process.env as Record<string, string>, tag, kind: 'pipes' })
  }

  info(id: string) {
    const c = this.children.get(id)!
    return { id, kind: c.kind, pid: c.proc.pid, cmd: '', args: [], cwd: tmpdir(), startedAt: 0, alive: c.exit === null, exit: c.exit, tag: c.tag, cols: 80, rows: 24, buffered: 0, attached: !!c.reader }
  }

  /** Pushes `{"event":"stop"}` to every connected host */
  askStop(): void {
    for (const s of this.controls) s.write(`${JSON.stringify({ event: 'stop' })}\n`)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const c of this.children.values()) if (c.exit === null) c.proc.kill('SIGKILL')
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((r) => this.server.close(() => r()))
    rmSync(this.dir, { recursive: true, force: true })
  }

  private spawnChild(req: { cmd: string; args: string[]; cwd: string; env: Record<string, string>; tag: unknown; kind: string }): string {
    const id = `c${this.next++}`
    const proc = spawn(req.cmd, req.args, { cwd: req.cwd, env: req.env, stdio: 'pipe', detached: true })
    const c = { proc, tag: req.tag, kind: req.kind, exit: null as { code: number | null; signal: number | null } | null, out: [] as Buffer[], reader: null as Socket | null }
    this.children.set(id, c)
    proc.stdout!.on('data', (d: Buffer) => (c.reader ? c.reader.write(d) : c.out.push(d)))
    proc.stdin!.on('error', () => {})
    proc.on('exit', (code, signal) => {
      c.exit = { code, signal: signal ? (({ SIGTERM: 15, SIGKILL: 9, SIGHUP: 1, SIGINT: 2 }) as Record<string, number>)[signal] ?? 0 : null }
      setTimeout(() => {
        c.reader?.end()
        for (const s of this.controls) s.write(`${JSON.stringify({ event: 'exit', id, ...c.exit })}\n`)
      }, 20)
    })
    return id
  }

  private onConn(s: Socket): void {
    this.sockets.add(s)
    s.on('close', () => this.sockets.delete(s))
    let buf = ''
    let role: 'hello' | 'control' | 'attach' = 'hello'
    let attached: string | null = null
    const onLine = (line: string) => {
      const req = JSON.parse(line) as Record<string, unknown>
      if (role === 'hello') {
        if (req.op === 'hello') {
          role = 'control'
          this.controls.add(s)
          s.write(`${JSON.stringify({ ok: true, protocol: 1, keeperPid: process.pid })}\n`)
          return
        }
        const c = this.children.get(String(req.id))
        if (!c) return void s.end(`${JSON.stringify({ ok: false, error: 'no child' })}\n`)
        role = 'attach'
        attached = String(req.id)
        s.write(`${JSON.stringify({ ok: true, child: this.info(attached) })}\n`)
        if (req.stream === 'err') return
        c.reader = s
        for (const d of c.out.splice(0)) s.write(d)
        if (c.exit) setTimeout(() => s.end(), 20)
        return
      }
      this.requests.push(req)
      const reply = (body: Record<string, unknown>) => s.write(`${JSON.stringify({ rid: req.rid, ok: true, ...body })}\n`)
      const c = this.children.get(String(req.id))
      switch (req.op) {
        case 'spawn': {
          const id = this.spawnChild(req as never)
          return reply({ child: this.info(id) })
        }
        case 'list':
          return reply({ children: [...this.children.keys()].map((id) => this.info(id)) })
        case 'signal':
          if (c && c.exit === null) process.kill(c.proc.pid!, String(req.signal) as NodeJS.Signals)
          return reply({})
        case 'close_stdin':
          c?.proc.stdin!.end()
          return reply({})
        case 'release':
          this.children.delete(String(req.id))
          return reply({})
        default:
          return reply({})
      }
    }
    s.on('data', (d: Buffer) => {
      if (role === 'attach') {
        const c = this.children.get(attached!)
        if (c && c.exit === null) c.proc.stdin!.write(d)
        return
      }
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) onLine(line)
        // The rest of the first packet of an attach is raw input
        if ((role as string) === 'attach' && buf) {
          const c = this.children.get(attached!)
          c?.proc.stdin!.write(buf)
          buf = ''
        }
      }
    })
    s.on('end', () => {
      if (role === 'attach' && attached) {
        this.detaches.push(attached)
        const c = this.children.get(attached)
        if (c?.reader === s) c.reader = null
        s.end()
      }
    })
    s.on('close', () => {
      this.controls.delete(s)
      const c = attached ? this.children.get(attached) : undefined
      if (c?.reader === s) c.reader = null
    })
    s.on('error', () => {})
  }
}
