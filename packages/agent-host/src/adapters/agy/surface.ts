import { runProgram } from '../../os.js'
import type { AdapterSurface, SurfaceInputs, ToolSurface } from '../contract.js'
import { findAgy } from './install.js'
import { SURFACE_BASELINE } from './surface-baseline.js'

/** What the installed `agy` offers, read without a turn and without a login: its version and `--help` */
async function gather(): Promise<SurfaceInputs> {
  const l = findAgy()
  if (!l) throw new Error('Antigravity CLI (agy) is not installed on this machine')
  const run = (args: string[]) => runProgram(l.command, [...l.args, ...args], { timeoutMs: 30_000 }).then((r) => r.stdout)
  return { version: (await run(['--version'])).trim(), help: await run(['--help']) }
}

export function readAgySurface(inputs: SurfaceInputs): ToolSurface {
  const help = inputs.help ?? ''
  const flags = [...help.matchAll(/^ {2}(--[\w-]+)(?: |$)/gm)].flatMap((m) => (m[1] ? [m[1]] : []))
  const after = help.slice(help.indexOf('Available subcommands:') + 1)
  const commands = help.includes('Available subcommands:') ? [...after.matchAll(/^ {2}([a-z][\w-]*)(?: |$)/gm)].flatMap((m) => (m[1] ? [m[1]] : [])) : []
  return { version: `agy ${inputs.version ?? 'unknown'}`, offered: { command: [...new Set(commands)].sort(), capability: [...new Set(flags)].sort() } }
}

const MEASURED = 'agy 1.4.7 and 1.4.8, docs/plans/antigravity-adapter.md §1'

export const AGY_SURFACE: AdapterSurface = {
  gather,
  read: readAgySurface,
  limitations: [
    {
      kind: 'capability',
      name: '--dangerously-skip-permissions',
      treatment: 'worked-around',
      measured: `${MEASURED}.2: print mode cannot ask, and a hook's allow is not enough without the flag`,
      offeredWhenMeasured: true,
      note: 'The session runs with the flag and Centralu\u2019s own PreToolUse hook is the only gate.',
    },
    {
      kind: 'command',
      name: 'models',
      treatment: 'dropped',
      measured: `${MEASURED}.7: prints id and label lines; --output-format json is refused`,
      offeredWhenMeasured: true,
      note: 'The model and effort lists come in the next version (PreInvocation); until then none is offered.',
    },
  ],
  baseline: SURFACE_BASELINE,
}
