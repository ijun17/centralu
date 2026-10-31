/**
 * What the `probe-codex-*` scripts share: a throwaway folder with a `.frames.jsonl` beside it, and a `codex
 * app-server` client that is initialized, records every frame and accepts every approval. Each probe starts its own
 * thread and says what it needs to know about the frames.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_INFO } from '@cc/protocol'
import { CodexClient, type ServerNotification, type ServerRequest } from '../src/adapters/codex/client.js'

export function probeDir(prefix: string, git = false) {
  const cwd = mkdtempSync(join(tmpdir(), prefix))
  if (git) execFileSync('git', ['init', '-q'], { cwd })
  const log = join(cwd, '..', `${cwd.split('/').pop()}.frames.jsonl`)
  const t0 = Date.now()
  const record = (dir: string, frame: unknown) => appendFileSync(log, JSON.stringify({ ms: Date.now() - t0, dir, frame }) + '\n')
  return { cwd, log, t0, record }
}

type Dir = ReturnType<typeof probeDir>

/**
 * `prefixOrDir` is a new folder's name prefix, or the `probeDir` of one that several clients share. `tag` prefixes the recorded direction ("A notification") when a probe runs two clients on one `dir`; `record: false`
 * leaves the frames to `onNotification`. `onRequest` runs before the approval is accepted.
 */
export async function openProbe(
  prefixOrDir: string | Dir,
  opts: { tag?: string; record?: boolean; onNotification?: (n: ServerNotification, client: CodexClient) => void; onRequest?: (r: ServerRequest) => void; onExit?: () => void } = {},
) {
  const dir = typeof prefixOrDir === 'string' ? probeDir(prefixOrDir) : prefixOrDir
  const at = opts.tag ? `${opts.tag} ` : ''
  const rec = opts.record !== false
  const client: CodexClient = new CodexClient(
    {
      onNotification: (n) => {
        if (rec) dir.record(`${at}notification`, n)
        opts.onNotification?.(n, client)
      },
      onServerRequest: (r) => {
        if (rec) dir.record(`${at}request`, r)
        opts.onRequest?.(r)
        client.respond(r.id, { decision: 'accept' })
      },
      onExit: () => opts.onExit?.(),
    },
    { cwd: dir.cwd },
  )
  await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
  client.notify('initialized')
  return { ...dir, client }
}
