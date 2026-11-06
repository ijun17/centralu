import { createRequire } from 'node:module'
import type { ToolProfile } from '../packages/agent-host/src/apps/contract.js'
import type { OrchestratorTools } from '../packages/agent-host/src/adapters/contract.js'
import { orchestratorToolSchemas, runOrchestratorTool } from '../packages/agent-host/src/sessions/orchestrator-tools.js'

/**
 * The host end of Centralu's stdio bridge, for a recording run (#1498): an ACP agent starts the real bridge script
 * (`codex/orchestrator-bridge.mjs`) from the `mcpServers` of `session/new`, and the script asks the host for the tool list and
 * runs each call there. This answers both as the host does (`rpc.ts`: `orchestrator.tools`, `orchestrator.tool`) with the
 * tools the scenario gives (`adapters/frames/fakes.test-helpers.ts`), so the agent's list, its calls and what it reads back are
 * real and the data behind the tools is fixed. A script, not a test helper: `ws` is the OS layer's (tooling/os-layer.js).
 */
export type BridgeHost = { url: string; token: string; close(): Promise<void> }

type Socket = { send(text: string): void; close(code: number, reason: string): void; terminate(): void; on(event: 'message', listener: (raw: Buffer) => void): void }
type Server = {
  clients: Iterable<Socket>
  address(): unknown
  on(event: 'connection', listener: (socket: Socket) => void): void
  once(event: 'listening', listener: () => void): void
  close(done: () => void): void
}
type Frame = { kind?: string; token?: string; id?: string; method?: string; params?: { sessionId?: string; name?: string; args?: Record<string, unknown> } }

const { WebSocketServer } = createRequire(new URL('../packages/agent-host/package.json', import.meta.url))('ws') as { WebSocketServer: new (options: { host: string; port: number }) => Server }

export async function startBridgeHost(tools: OrchestratorTools, profile: ToolProfile): Promise<BridgeHost> {
  const token = 'recording-bridge'
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let frame: Frame
      try {
        frame = JSON.parse(raw.toString()) as Frame
      } catch {
        return
      }
      if (frame.kind === 'hello') {
        if (frame.token !== token) return void socket.close(4001, 'refused')
        return void socket.send(JSON.stringify({ kind: 'hello_ok', protocolVersion: 1, currentSeq: 0 }))
      }
      if (frame.kind !== 'rpc') return
      const answer = async (): Promise<unknown> => {
        if (frame.method === 'orchestrator.tools') return orchestratorToolSchemas(profile)
        if (frame.method === 'orchestrator.tool') return runOrchestratorTool(tools, String(frame.params?.name), frame.params?.args ?? {}, { sessionId: frame.params?.sessionId ?? null, profile })
        throw new Error(`no such method: ${frame.method}`)
      }
      answer().then(
        (result) => socket.send(JSON.stringify({ kind: 'res', id: frame.id, ok: true, result })),
        (e: Error) => socket.send(JSON.stringify({ kind: 'res', id: frame.id, ok: false, error: { message: e.message } })),
      )
    })
  })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as { port: number }
  return {
    url: `ws://127.0.0.1:${port}`,
    token,
    close: () => new Promise<void>((resolve) => {
      for (const client of server.clients) client.terminate()
      server.close(() => resolve())
    }),
  }
}
