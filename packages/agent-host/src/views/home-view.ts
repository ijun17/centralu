import type { CallToolResult } from '@modelcontextprotocol/client'

export type HomeView = {
  instanceId: string
  tool: string
  resourceUri: string
  /** What to send the view as tool-input — the exact arguments the host called with */
  toolInput: Record<string, unknown>
  /** The app's answer as is — becomes the view's tool-result */
  toolResult: CallToolResult
  runId: string
}
