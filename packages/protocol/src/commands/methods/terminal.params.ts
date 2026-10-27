import { z } from 'zod'
import { ProjectId } from '../../entities.js'
import { machineParam } from '../machine-fields.js'

/** The parameters of the `terminal` methods, which the host validates (docs/protocol.md §3). Their results: ./terminal.results.ts */
export const terminalParams = {
  /** File search for `@` autocomplete (within the project only) */
  /**
   * Leftover processes still running under our folder (requested by the person on 2026-09-07).
   *
   * A dev server an agent started via bash has both its parent and its process group detached
   * from ours, so our shutdown procedure cannot catch it (measured). Instead of killing it, this
   * **shows it** and lets the person choose.
   */
  'processes.strays': z.object({ ...machineParam }),
  /** Stops the chosen ones (SIGTERM). The host re-measures the condition right before killing them */
  'processes.stop': z.object({ pids: z.array(z.number()), ...machineParam }),
  'terminal.list': z.object({ projectId: ProjectId }),
  /** Opens one more terminal */
  'terminal.create': z.object({
    projectId: ProjectId,
    cols: z.number().default(80),
    rows: z.number().default(24),
  }),
  /** Closes one terminal (ends the shell and discards its history) */
  'terminal.close': z.object({ terminalId: z.string() }),
  'terminal.input': z.object({ terminalId: z.string(), data: z.string() }),
  'terminal.resize': z.object({ terminalId: z.string(), cols: z.number(), rows: z.number() }),
  /** Ends the shell and starts a fresh one (for when it hangs) */
  'terminal.restart': z.object({
    terminalId: z.string(),
    cols: z.number().default(80),
    rows: z.number().default(24),
  }),
  /** Runs a frequently used command (#60). If the same command is already running, it is killed and restarted */
  'commands.run': z.object({
    projectId: ProjectId,
    command: z.string(),
    cols: z.number().default(100),
    rows: z.number().default(30),
  }),
  /** Stops a dev server. The log remains — an exit is also a result */
  'commands.stop': z.object({ projectId: ProjectId, command: z.string() }),
  /** The status of commands that have run before (for list badges — the log itself comes from commands.log) */
  'commands.state': z.object({ projectId: ProjectId }),
  /** The last run of one command, log included. Null if it has never run */
  'commands.log': z.object({ projectId: ProjectId, command: z.string() }),
  'commands.resize': z.object({
    projectId: ProjectId,
    command: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),
} as const
