import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { AdapterSurface, SurfaceInputs, ToolSurface } from '../contract.js'
import { acpCapabilities, acpInitialize } from '../acp/surface-kit.js'
import { findCursor } from './install.js'
import { SURFACE_BASELINE } from './surface-baseline.js'

const exec = promisify(execFile)

/**
 * What the installed Cursor CLI offers (#270), read without a session and without a login: its `--help` commands, the
 * capabilities its ACP server answers `initialize` with, and the update kinds and `cursor/` methods its bundle names
 * (`sessionUpdate:"…"`, the way its ACP server writes them; read from 2026.10.22-27dcf5f's `3635.index.js`).
 */
async function gather(): Promise<SurfaceInputs> {
  const install = findCursor()
  if (!install) throw new Error('Cursor CLI is not installed on this machine (https://cursor.com/install)')
  const env = { ...process.env, ...install.env }
  const { stdout: help } = await exec(install.command, [...install.args, '--help'], { timeout: 30_000, windowsHide: true, env })
  const initialize = await acpInitialize({ command: install.command, args: [...install.args, 'acp'], env }, 'cursor-surface')
  const dir = dirname(install.args[0] ?? install.command)
  const names = new Set<string>()
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const text = readFileSync(join(dir, f), 'utf8')
    if (!text.includes('session/request_permission') && !text.includes('cursor_login')) continue
    for (const m of text.matchAll(/sessionUpdate:"([a-z_]+)"|"(cursor\/[a-z_]+)"/g)) {
      const name = m[1] ?? m[2]
      if (name) names.add(name)
    }
  }
  return { version: install.version, help, initialize, bundle: JSON.stringify([...names].sort()) }
}

export function readCursorSurface(inputs: SurfaceInputs): ToolSurface {
  const commands = [...(inputs.help ?? '').matchAll(/^ {2}([a-z][\w-]*)(?: |$)/gm)].flatMap((m) => (m[1] ? [m[1]] : []))
  const bundle = z.array(z.string()).parse(JSON.parse(inputs.bundle ?? '[]'))
  return {
    version: `agent ${inputs.version ?? 'unknown'}`,
    offered: {
      command: [...new Set([...commands, ...bundle.filter((n) => n.startsWith('cursor/'))])].sort(),
      message: bundle.filter((n) => !n.startsWith('cursor/')).sort(),
      capability: acpCapabilities(inputs.initialize),
    },
  }
}

const BUNDLE = 'read in the 2026.10.22-27dcf5f bundle (3635.index.js), 2026-10-26'

export const CURSOR_SURFACE: AdapterSurface = {
  gather,
  read: readCursorSurface,
  limitations: [
    {
      kind: 'capability',
      name: 'authMethods.cursor_login',
      treatment: 'blocked',
      measured: 'agent 2026.10.22-27dcf5f, not logged in: authenticate {methodId: cursor_login} started the browser login flow and did not answer in 8 s',
      offeredWhenMeasured: true,
      note: 'Never called: a background session must not open a browser. Logging in stays `agent login` in a terminal.',
    },
    {
      kind: 'message',
      name: 'current_mode_update',
      treatment: 'dropped',
      measured: BUNDLE,
      offeredWhenMeasured: true,
      note: 'Modes (agent, plan, ask) are not offered until the settings menu maps them (PR 2).',
    },
    {
      kind: 'message',
      name: 'subagent_spawned',
      treatment: 'dropped',
      measured: `${BUNDLE}: sent only when the client advertises sub-agent support, which Centralu does not yet`,
      offeredWhenMeasured: true,
      note: 'Sub-agents run as ordinary tool calls until they are mapped onto subagent_event (PR 2).',
    },
    {
      kind: 'message',
      name: 'subagent_state_update',
      treatment: 'dropped',
      measured: `${BUNDLE}: as subagent_spawned`,
      offeredWhenMeasured: true,
      note: 'As subagent_spawned.',
    },
    ...(['cursor/ask_question', 'cursor/create_plan', 'cursor/update_todos', 'cursor/task', 'cursor/generate_image'] as const).map((name) => ({
      kind: 'command' as const,
      name,
      treatment: 'blocked' as const,
      measured: `${BUNDLE}: Cursor's own request to the client`,
      offeredWhenMeasured: true,
      note:
        name === 'cursor/ask_question'
          ? 'Answered method-not-found, so Cursor asks each question as a session/request_permission whose options are the answers (its own fallback). Question cards come in PR 2.'
          : 'Answered method-not-found; mapped in PR 2.',
    })),
    {
      kind: 'command',
      name: 'cursor/list_available_models',
      treatment: 'dropped',
      measured: 'agent 2026.10.22-27dcf5f, logged in: answers every model with its options (effort as category thought_level, context and fast as model_config)',
      offeredWhenMeasured: true,
      note: 'The model list comes in PR 2. Setting a model through session/set_config_option also writes it to ~/.cursor/acp-config.json (measured), which would change the default of every Cursor session the person runs, so PR 1 runs Cursor’s default model.',
    },
  ],
  baseline: SURFACE_BASELINE,
}
