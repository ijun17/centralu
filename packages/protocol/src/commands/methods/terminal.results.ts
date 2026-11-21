import { z } from 'zod'
import { CommandRunInfo, TerminalInfo } from '../projects.js'

/** Results of the `terminal` methods, read through `parseRpcResult`. Params and what each method does: ./terminal.params.ts */
export const terminalResults = {
  'processes.strays': z.array(z.object({ pid: z.number(), command: z.string(), cwd: z.string() })),
  'processes.stop': z.object({ stopped: z.number() }),
  'terminal.list': z.object({ terminals: z.array(TerminalInfo) }),
  'terminal.create': TerminalInfo,
  'terminal.close': z.object({ ok: z.literal(true) }),
  'terminal.input': z.object({ ok: z.literal(true) }),
  'terminal.resize': z.object({ ok: z.literal(true) }),
  'terminal.restart': TerminalInfo,
  'commands.run': CommandRunInfo,
  'commands.stop': z.object({ ok: z.literal(true) }),
  'commands.state': z.object({ runs: z.array(CommandRunInfo) }),
  'commands.log': z.object({ run: CommandRunInfo.extend({ history: z.string() }).nullable() }),
  'commands.resize': z.object({ ok: z.literal(true) }),
} as const
