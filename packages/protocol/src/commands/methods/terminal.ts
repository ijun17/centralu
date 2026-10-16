import { z } from 'zod'
import { ProjectId } from '../../entities.js'
import { machineParam } from '../machine-fields.js'
import { CommandRunInfo, TerminalInfo } from '../projects.js'

export const terminalMethods = {
  /** File search for `@` autocomplete (within the project only) */
  /**
   * Leftover processes still running under our folder (requested by the person on 2026-09-07).
   *
   * A dev server an agent started via bash has both its parent and its process group detached
   * from ours, so our shutdown procedure cannot catch it (measured). Instead of killing it, this
   * **shows it** and lets the person choose.
   */
  'processes.strays': {
    params: z.object({ ...machineParam }),
    result: z.array(z.object({ pid: z.number(), command: z.string(), cwd: z.string() })),
  },
  /** Stops the chosen ones (SIGTERM). The host re-measures the condition right before killing them */
  'processes.stop': {
    params: z.object({ pids: z.array(z.number()), ...machineParam }),
    result: z.object({ stopped: z.number() }),
  },
  'terminal.list': {
    params: z.object({ projectId: ProjectId }),
    result: z.object({ terminals: z.array(TerminalInfo) }),
  },
  /** Opens one more terminal */
  'terminal.create': {
    params: z.object({ projectId: ProjectId, cols: z.number().default(80), rows: z.number().default(24) }),
    result: TerminalInfo,
  },
  /** Closes one terminal (ends the shell and discards its history) */
  'terminal.close': {
    params: z.object({ terminalId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'terminal.input': {
    params: z.object({ terminalId: z.string(), data: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'terminal.resize': {
    params: z.object({ terminalId: z.string(), cols: z.number(), rows: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Ends the shell and starts a fresh one (for when it hangs) */
  'terminal.restart': {
    params: z.object({ terminalId: z.string(), cols: z.number().default(80), rows: z.number().default(24) }),
    result: TerminalInfo,
  },
  /** Runs a frequently used command (#60). If the same command is already running, it is killed and restarted */
  'commands.run': {
    params: z.object({ projectId: ProjectId, command: z.string(), cols: z.number().default(100), rows: z.number().default(30) }),
    result: CommandRunInfo,
  },
  /** Stops a dev server. The log remains — an exit is also a result */
  'commands.stop': {
    params: z.object({ projectId: ProjectId, command: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** The status of commands that have run before (for list badges — the log itself comes from commands.log) */
  'commands.state': {
    params: z.object({ projectId: ProjectId }),
    result: z.object({ runs: z.array(CommandRunInfo) }),
  },
  /** The last run of one command, log included. Null if it has never run */
  'commands.log': {
    params: z.object({ projectId: ProjectId, command: z.string() }),
    result: z.object({ run: CommandRunInfo.extend({ history: z.string() }).nullable() }),
  },
  'commands.resize': {
    params: z.object({ projectId: ProjectId, command: z.string(), cols: z.number(), rows: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
} as const
