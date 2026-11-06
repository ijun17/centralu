import { WebSocketServer, type WebSocket } from 'ws'
import type { ToolProfile } from '../../apps/contract.js'
import { orchestratorToolSchemas, runOrchestratorTool } from '../../sessions/orchestrator-tools.js'
import type { OrchestratorTools } from '../contract.js'

/**
 * The host end of Centralu's stdio bridge, for a recording run (#1498): an ACP agent starts the real bridge script
 * (`codex/orchestrator-bridge.mjs`) from the `mcpServers` of `session/new`, and the script asks the host for the tool list and
 * runs each call there. This answers both as the host does (`rpc.ts`: `orchestrator.tools`, `orchestrator.tool`) with the
 * tools the scenario gives (`fakes.test-helpers.ts`), so the agent's list, its calls and what it reads back are real and the
 * data behind the tools is fixed.
 */
export type BridgeHost = { url: string; token: string; close(): Promise<void> }

export async function startBridgeHost(tools: OrchestratorTools, profile: ToolProfile): Promise<BridgeHost> {
  const token = 'recording-bridge'
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { kind: string; id?: string; method?: string; params?: { sessionId?: string; name?: string; args?: Record<string, unknown> } }
      if (frame.kind === 'hello') return void socket.send(JSON.stringify({ kind: 'hello_ok', protocolVersion: 1, currentSeq: 0 }))
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
