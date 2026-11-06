/**
 * What the recording scripts share (`frames-record.mts`, `frames-record-host.mts`, #1498): the private settings folder a Codex run
 * uses, and removing a folder a tool's process may still hold.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The MCP server a scenario with `settings: 'mcp'` configures: stdio, one tool, `ping`, which answers `pong` */
const PROBE_MCP = `let buf = ''
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
process.stdin.on('data', (c) => {
  buf += c
  for (let nl; (nl = buf.indexOf('\\n')) >= 0; ) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const { id, method, params } = JSON.parse(line)
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } })
    else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'ping', description: 'Answers pong.', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } }] } })
    else if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pong' }] } })
    else if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
  }
})
process.stdin.on('end', () => process.exit(0))
`


/**
 * A Claude Code configuration folder of its own for the run (`CLAUDE_CONFIG_DIR`), so no setting, plugin, hook or conversation of
 * the person's is read or written. It holds a copy of the sign-in alone (`.credentials.json`; where the sign-in is in the system's
 * keychain instead there is nothing to copy, and the run says so). Claude Code refreshes an expiring token in place, so, as with
 * Codex, `finish` puts a changed copy back into the person's file, unless that file changed meanwhile.
 * `mcpConfig` writes the probe MCP server's configuration (`PROBE_MCP`) and returns its file, which a scenario with `settings:
 * 'mcp'` has passed to the CLI as `--mcp-config` (a user-scope server would load only with the person's settings sources on).
 */
export function temporaryClaudeConfig(parent: string): { finish(): void; mcpConfig(): string } {
  const real = join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), '.credentials.json')
  const home = join(parent, 'claude-config')
  mkdirSync(home, { recursive: true })
  const copy = join(home, '.credentials.json')
  if (!existsSync(real)) throw new Error('claude is not signed in through a credentials file: run `claude` and sign in first')
  copyFileSync(real, copy)
  const before = readFileSync(copy, 'utf8')
  process.env.CLAUDE_CONFIG_DIR = home
  // The person's claude.ai connectors (their Drive, mail, notes) come with the sign-in and would be live tools of the run: off
  process.env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'
  let done = false
  return {
    mcpConfig() {
      const server = join(home, 'probe-mcp.mjs')
      writeFileSync(server, PROBE_MCP)
      const file = join(home, 'probe-mcp.json')
      writeFileSync(file, JSON.stringify({ mcpServers: { probe: { command: 'node', args: [server] } } }))
      return file
    },
    finish() {
      if (done) return
      done = true
      // It never throws: the folder holding the copy of the sign-in is removed after it, whatever happens here
      try {
        const now = readFileSync(copy, 'utf8')
        if (now === before) return
        if (readFileSync(real, 'utf8') !== before) return console.error('[record] the sign-in was refreshed during the run, and the person\'s own file was too: left as it is')
        const next = `${real}.${process.pid}.tmp`
        writeFileSync(next, now, { mode: 0o600 })
        renameSync(next, real)
        console.log('[record] the sign-in was refreshed during the run: kept in the person\'s credentials file')
      } catch (e) {
        console.error(`[record] could not put the refreshed sign-in back into the person's credentials file: ${(e as Error).message}`)
      }
    },
  }
}

/**
 * A Codex settings folder of its own for the run (`CODEX_HOME`), so no setting, skill, hook or thread of the person's is read or
 * written. It holds a copy of the sign-in alone. Codex rotates the refresh token when it refreshes one, which would leave the
 * person's own file with a token it no longer accepts: if the copy changed, `finish` puts it back into the person's file, unless
 * that file changed meanwhile (another Codex refreshed it: its token is the newer one and stays). The put-back is a rename, so
 * the file is never half written.
 */
export function temporaryCodexHome(parent: string): { finish(): void; settings(which: 'mcp' | undefined): void } {
  const real = join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'auth.json')
  const home = join(parent, 'codex-home')
  mkdirSync(home, { recursive: true })
  const copy = join(home, 'auth.json')
  if (!existsSync(real)) throw new Error('codex is not signed in: run `codex login` first')
  copyFileSync(real, copy)
  const before = readFileSync(copy, 'utf8')
  process.env.CODEX_HOME = home
  let done = false
  return {
    // The settings file a scenario asks for (`Scenario.settings`), or none
    settings(which) {
      const config = join(home, 'config.toml')
      if (which !== 'mcp') return rmSync(config, { force: true })
      const server = join(home, 'probe-mcp.mjs')
      writeFileSync(server, PROBE_MCP)
      writeFileSync(config, `[mcp_servers.probe]\ncommand = "node"\nargs = [${JSON.stringify(server)}]\n`)
    },
    finish() {
      if (done) return
      done = true
      const now = readFileSync(copy, 'utf8')
      if (now === before) return
      if (readFileSync(real, 'utf8') !== before) return console.error('[record] the sign-in was refreshed during the run, and the person\'s own file was too: left as it is')
      const next = `${real}.${process.pid}.tmp`
      writeFileSync(next, now, { mode: 0o600 })
      renameSync(next, real)
      console.log('[record] the sign-in was refreshed during the run: kept in the person\'s auth file')
    },
  }
}


/** Removes a folder a tool's process may still hold for a moment after the session closed (Windows will not remove a folder that is some process's working folder) */
export async function removeDir(dir: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      if (tries >= 60) return console.error(`[record] could not remove ${dir}: ${(e as Error).message}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

