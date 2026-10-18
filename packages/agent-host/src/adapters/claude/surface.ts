import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterSurface, SurfaceInputs, SurfaceLimitation, ToolSurface } from '../contract.js'
import { compareSurface, surfaceLogLines } from '../surface-drift.js'
import { Declarations, helpSurface, literalsOf } from '../surface-read.js'
import { SURFACE_BASELINE } from './surface-baseline.js'

/**
 * What Claude Code offers, as this adapter reads it (#270, `contract/surface.ts`).
 *
 * The SDK only defines the protocol; what runs is the person's installed `claude`. So the surface comes from both:
 *
 *   message     the SDK's stdout union (`StdoutMessage`, or `SDKMessage` in an SDK without it), keyed as normalize.ts
 *               keys them: `type`, or `system/<subtype>`
 *   capability  the SDK's `Options` keys (`option:`) and `Query` methods (`query:`), and the CLI's `--help` flags and
 *               subcommands (`flag:`, `subcommand:`)
 *   command     only at run time: the init message's `slash_commands` (session.ts). Nothing the CLI prints without a
 *               session lists them, so the drift run leaves this kind out and the baseline has none.
 */

const SDK = '@anthropic-ai/claude-agent-sdk'

const need = (inputs: SurfaceInputs, key: string): string => {
  const v = inputs[key]
  if (v === undefined) throw new Error(`the Claude surface needs ${key}`)
  return v
}

export function readClaudeSurface(inputs: SurfaceInputs): ToolSurface {
  const d = new Declarations(need(inputs, 'sdk.d.ts'))
  const messages = new Set<string>()
  for (const object of d.objectsOf(d.find('StdoutMessage') !== null ? 'StdoutMessage' : 'SDKMessage')) {
    for (const type of literalsOf(object, 'type')) {
      const subtypes = type === 'system' ? literalsOf(object, 'subtype') : []
      if (subtypes.length === 0) messages.add(type)
      for (const s of subtypes) messages.add(`system/${s}`)
    }
  }
  if (messages.size === 0) throw new Error('the SDK message union carries no type: did its shape change?')
  const capabilities = new Set([
    ...d.members('Options').map((n) => `option:${n}`),
    ...d.members('Query').map((n) => `query:${n}`),
    ...helpSurface(need(inputs, 'claude --help')),
  ])
  const sdk = (JSON.parse(need(inputs, 'package.json')) as { version?: string }).version ?? '?'
  return {
    version: `${need(inputs, 'claude --version').trim()} · SDK ${sdk}`,
    offered: { message: [...messages].sort(), capability: [...capabilities].sort() },
  }
}

/**
 * What this adapter blocks, drops or works around, each with what it was measured on. The rule for a new one: a
 * dated comment that says "this does not work" gets an entry here, so the drift run re-checks it when the tool moves.
 */
export const CLAUDE_LIMITATIONS: readonly SurfaceLimitation[] = [
  {
    kind: 'command',
    name: 'goal',
    treatment: 'blocked',
    measured: '2026-09-07, SDK 0.3.231 and 0.3.263',
    offeredWhenMeasured: false,
    followsOffer: true,
    note:
      'Headless, the model only role-played the goal hook, so `/goal` was refused here. The CLI offers it since 2.1.282 ' +
      "(2026-10-03); the session now sends it when the CLI's command list has it and refuses it otherwise (session.ts).",
  },
  {
    kind: 'message',
    name: 'active_goal',
    treatment: 'worked-around',
    measured: '2026-10-03, CLI 2.1.282 through SDK 0.3.263',
    offeredWhenMeasured: true,
    note:
      'Declared, but the CLI writes it to stdout only in a remote session, so the goal badge is read off the stream ' +
      '(`ClaudeGoalTracker`). When a CLI sends it, the tracker stands down.',
  },
  // The #58 survey's "show or store it, wire it when it is seen" rows: out of CLAUDE_KNOWN_TYPES on purpose
  ...['auth_status', 'tool_use_summary', 'system/commands_changed', 'system/memory_recall', 'system/permission_denied'].map(
    (name): SurfaceLimitation => ({
      kind: 'message',
      name,
      treatment: 'dropped',
      measured: '2026-10-04, CLI 2.1.282 and SDK 0.3.263 (#58 survey)',
      offeredWhenMeasured: true,
      note: 'The survey would show or store it, and nothing maps it yet: said once per session in host.log (`UnmappedTypes`).',
    }),
  ),
]

/**
 * The init message's `slash_commands` against the command limitations, as host.log lines (#270): the one part of the
 * surface only a running CLI says. Once per process (session.ts). A limitation the adapter already follows at run time
 * (`followsOffer`, `/goal`) says nothing.
 */
export function initSurfaceLines(
  sessionId: string,
  slashCommands: readonly unknown[],
  limitations: readonly SurfaceLimitation[] = CLAUDE_LIMITATIONS,
): string[] {
  const command = slashCommands.filter((c): c is string => typeof c === 'string')
  return surfaceLogLines('claude', sessionId, compareSurface({ version: 'init', offered: { command } }, limitations))
}

export const CLAUDE_SURFACE: AdapterSurface = {
  async gather(env) {
    const sdk = await env.packageDir(SDK)
    return {
      'package.json': readFileSync(join(sdk, 'package.json'), 'utf8'),
      'sdk.d.ts': readFileSync(join(sdk, 'sdk.d.ts'), 'utf8'),
      'claude --version': await env.run('claude', ['--version']),
      'claude --help': await env.run('claude', ['--help']),
    }
  },
  read: readClaudeSurface,
  limitations: CLAUDE_LIMITATIONS,
  baseline: SURFACE_BASELINE,
}
