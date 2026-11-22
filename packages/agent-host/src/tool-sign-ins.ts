import { setupOfDetection, type NormalizedEvent, type ToolName, type ToolSetup } from '@cc/protocol'

/**
 * A tool signed in from a terminal that a session's turn found signed out (`not_logged_in`): every window is told at once (`tool_setup`), not at
 * its next detect. A window keeps the setup it was told over what it detects, so a detect here that finds the tool signed in again is told too.
 * A tool with a setup of its own (`AgentAdapter.setup`) tells its windows itself
 */
export class ToolSignIns {
  private readonly told = new Set<ToolName>()

  constructor(
    private readonly emit: (e: NormalizedEvent) => void,
    private readonly toolOf: (sessionId: string) => ToolName | undefined,
    private readonly ownSetup: (tool: ToolName) => boolean,
  ) {}

  /** Every session event, as the manager emits it */
  observe(e: NormalizedEvent): void {
    if (e.type !== 'error' || e.error.code !== 'not_logged_in' || !e.sessionId) return
    const tool = this.toolOf(e.sessionId)
    if (!tool || this.ownSetup(tool) || this.told.has(tool)) return
    this.told.add(tool)
    this.emit({ type: 'tool_setup', tool, setup: setupOfDetection(true, false) })
  }

  /** What a detect found of `tool` */
  detected(tool: ToolName, setup: ToolSetup): void {
    if (setup.state !== 'signed_out' && this.told.delete(tool)) this.emit({ type: 'tool_setup', tool, setup })
  }
}
