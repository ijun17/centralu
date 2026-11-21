import { z } from 'zod'
import { ProjectId } from '../../entities.js'
import { machineParam } from '../machine-fields.js'

/** Params of the `terminal` methods, parsed by the host (docs/protocol.md §3). Results: ./terminal.results.ts */
export const terminalParams = {
  /**
   * Processes left running under our folder: a dev server an agent started through bash detaches its parent and process
   * group from ours, so shutdown cannot catch it (measured). Shown for the person to choose, never killed by itself.
   */
  'processes.strays': z.object({ ...machineParam }),
  /** SIGTERM; the host measures the condition again right before */
  'processes.stop': z.object({ pids: z.array(z.number()), ...machineParam }),
  /** A terminal's identity is its cwd, not a session: a worktree session has its own terminals */
  'terminal.list': z.object({ projectId: ProjectId }),
  'terminal.create': z.object({
    projectId: ProjectId,
    cols: z.number().default(80),
    rows: z.number().default(24),
  }),
  /** Ends the shell and discards its history */
  'terminal.close': z.object({ terminalId: z.string() }),
  'terminal.input': z.object({ terminalId: z.string(), data: z.string() }),
  'terminal.resize': z.object({ terminalId: z.string(), cols: z.number(), rows: z.number() }),
  /** A fresh shell, for one that hangs */
  'terminal.restart': z.object({
    terminalId: z.string(),
    cols: z.number().default(80),
    rows: z.number().default(24),
  }),
  /** The same command already running is killed and started again */
  'commands.run': z.object({
    projectId: ProjectId,
    command: z.string(),
    cols: z.number().default(100),
    rows: z.number().default(30),
  }),
  /** The log stays: an exit is a result too */
  'commands.stop': z.object({ projectId: ProjectId, command: z.string() }),
  /** For list badges; the log itself comes from `commands.log` */
  'commands.state': z.object({ projectId: ProjectId }),
  /** Null if it never ran */
  'commands.log': z.object({ projectId: ProjectId, command: z.string() }),
  'commands.resize': z.object({
    projectId: ProjectId,
    command: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),
} as const
