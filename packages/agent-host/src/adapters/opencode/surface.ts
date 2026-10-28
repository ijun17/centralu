import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { z } from 'zod'
import { asObj } from '../../json-value.js'
import type { AdapterSurface, SurfaceInputs, ToolSurface } from '../contract.js'
import { startToolProcess } from '../core/tool-process.js'
import { AcpConnection } from '../acp/connection.js'
import { findOpenCode } from './install.js'
import { SURFACE_BASELINE } from './surface-baseline.js'

const exec = promisify(execFile)

const Initialized = z.looseObject({ agentCapabilities: z.unknown().optional(), authMethods: z.array(z.looseObject({ id: z.string() })).optional() })

/**
 * What the installed OpenCode offers (#270), read without a session and without a login: its `--help` commands, the
 * capabilities its ACP server answers `initialize` with, and the update kinds its binary writes (`sessionUpdate:"…"`,
 * read from 1.19.4's `opencode.exe`, which the npm package's install step puts at `bin/`).
 */
async function gather(): Promise<SurfaceInputs> {
  const install = findOpenCode()
  if (!install) throw new Error('OpenCode is not installed on this machine (npm i -g opencode-ai)')
  const [{ stdout: version }, shown] = await Promise.all([
    exec(install.command, [...install.args, '--version'], { timeout: 30_000, windowsHide: true }),
    exec(install.command, [...install.args, '--help'], { timeout: 30_000, windowsHide: true }),
  ])
  // Measured: its help goes to stderr
  const help = shown.stdout + shown.stderr
  const proc = startToolProcess({ command: install.command, args: [...install.args, 'acp'], cwd: process.cwd(), env: process.env })
  const conn = new AcpConnection(proc, { onNotification: () => {}, onRequest: async () => null, onExit: () => {} }, 'opencode-surface')
  let init: unknown
  try {
    init = await conn.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'centralu-surface', version: '1' } }, 60_000)
  } finally {
    await conn.dispose()
  }
  // The binary itself (a JavaScript bundle compiled in): the update kinds are string literals in it
  const names = new Set([...readFileSync(install.command).toString('latin1').matchAll(/sessionUpdate:"([a-z_]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : [])))
  return { version: version.trim(), help, initialize: JSON.stringify(init), bundle: JSON.stringify([...names].sort()) }
}

/** Keys of a capability object, flattened (`sessionCapabilities.close`), so a new one shows as a new name */
function capabilityNames(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : []
  const entries = Object.entries(asObj(value))
  if (entries.length === 0) return prefix ? [prefix] : []
  return entries.flatMap(([k, v]) => (typeof v === 'object' && v !== null ? capabilityNames(v, prefix ? `${prefix}.${k}` : k) : [prefix ? `${prefix}.${k}` : k]))
}

export function readOpenCodeSurface(inputs: SurfaceInputs): ToolSurface {
  const init = Initialized.parse(JSON.parse(inputs.initialize ?? '{}'))
  const commands = [...(inputs.help ?? '').matchAll(/^ {2}opencode ([a-z][\w-]*)/gm)].flatMap((m) => (m[1] ? [m[1]] : []))
  return {
    version: `opencode ${inputs.version ?? 'unknown'}`,
    offered: {
      command: [...new Set(commands)].sort(),
      message: z.array(z.string()).parse(JSON.parse(inputs.bundle ?? '[]')).sort(),
      capability: [...capabilityNames(init.agentCapabilities), ...(init.authMethods ?? []).map((a) => `authMethods.${a.id}`)].sort(),
    },
  }
}

const MEASURED = 'opencode 1.19.4, 2026-10-26'

export const OPENCODE_SURFACE: AdapterSurface = {
  gather,
  read: readOpenCodeSurface,
  limitations: [
    {
      kind: 'message',
      name: 'compaction_update',
      treatment: 'worked-around',
      measured: `${MEASURED}: /compact ran with the client advertising session.compaction and sent no compaction frame, only text and a smaller usage_update`,
      offeredWhenMeasured: false,
      note: 'Its compaction is read from the compact turn Centralu started (infersCompaction, §5.6): ended end_turn with a smaller reading. When this kind appears, the frames can replace the inference.',
    },
    {
      kind: 'capability',
      name: 'authMethods.opencode-login',
      treatment: 'blocked',
      measured: `${MEASURED}: session/new works without authenticate (its own free models), and a provider's key is the person's OpenCode settings`,
      offeredWhenMeasured: true,
      note: 'Never called: logging in stays `opencode auth login` in a terminal.',
    },
    {
      kind: 'capability',
      name: 'sessionCapabilities.resume',
      treatment: 'dropped',
      measured: `${MEASURED}: session/load answered in about 1 s, session/resume in about 45 s`,
      offeredWhenMeasured: true,
      note: 'A conversation is reopened with session/load, whose replay is dropped.',
    },
    {
      kind: 'capability',
      name: 'sessionCapabilities.fork',
      treatment: 'dropped',
      measured: MEASURED,
      offeredWhenMeasured: true,
      note: 'Forks start a new conversation with the handoff, as for any tool, until a fork maps onto session/fork.',
    },
    {
      kind: 'message',
      name: 'config_option_update',
      treatment: 'dropped',
      measured: MEASURED,
      offeredWhenMeasured: true,
      note: 'The model and mode options are not offered in the settings menu yet; the person’s OpenCode default model runs.',
    },
  ],
  baseline: SURFACE_BASELINE,
}
