import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterSurface, SurfaceInputs, SurfaceLimitation, ToolSurface } from '../contract.js'
import { helpSurface, methodsOf } from '../surface-read.js'
import { SURFACE_BASELINE } from './surface-baseline.js'

/**
 * What Codex offers, as this adapter reads it (#270, `contract/surface.ts`). Codex generates its app-server protocol
 * (`codex app-server generate-ts`, the same bindings `codex-bindings.mjs --check` reads), so the surface is exact:
 *
 *   command     the client request methods (`ClientRequest.ts`): what the adapter can ask
 *   message     the server notification and server request methods (`ServerNotification.ts`, `ServerRequest.ts`):
 *               what the app-server can send
 *   capability  the CLI's `--help` flags and subcommands (`flag:`, `subcommand:`)
 */

const FILES = ['ClientRequest.ts', 'ServerNotification.ts', 'ServerRequest.ts'] as const

const need = (inputs: SurfaceInputs, key: string): string => {
  const v = inputs[key]
  if (v === undefined) throw new Error(`the Codex surface needs ${key}`)
  return v
}

export function readCodexSurface(inputs: SurfaceInputs): ToolSurface {
  const messages = new Set([
    ...methodsOf(need(inputs, 'ServerNotification.ts'), 'ServerNotification'),
    ...methodsOf(need(inputs, 'ServerRequest.ts'), 'ServerRequest'),
  ])
  return {
    version: need(inputs, 'codex --version').trim(),
    offered: {
      command: methodsOf(need(inputs, 'ClientRequest.ts'), 'ClientRequest'),
      message: [...messages].sort(),
      capability: helpSurface(need(inputs, 'codex --help')),
    },
  }
}

/**
 * What this adapter blocks, drops or works around, each with what it was measured on (see the Claude adapter's list for
 * the rule). The slash commands Codex runs as requests (`/compact`, `/review`, `/goal`, slash-commands.ts) are not
 * here: they use the protocol's own requests, and a request the protocol adds shows up as new.
 */
export const CODEX_LIMITATIONS: readonly SurfaceLimitation[] = [
  // The #58 survey's rows to wire "when it is seen" or at low priority: out of CODEX_KNOWN_NOTIFICATIONS on purpose
  ...[
    'item/reasoning/textDelta',
    'item/mcpToolCall/progress',
    'item/commandExecution/terminalInteraction',
    'model/safetyBuffering/updated',
    'model/verification',
    'modelProvider/authRecoveryStarted',
    'modelProvider/authRecoveryCompleted',
    'skills/changed',
    'thread/reverted',
  ].map(
    (name): SurfaceLimitation => ({
      kind: 'message',
      name,
      treatment: 'dropped',
      measured: '2026-10-04, codex-cli 0.160.0 (#58 survey)',
      offeredWhenMeasured: true,
      note: 'The survey would show or store it, and nothing maps it yet: said once per session in host.log (`UnmappedTypes`).',
    }),
  ),
]

export const CODEX_SURFACE: AdapterSurface = {
  async gather(env) {
    const out = env.tempDir()
    await env.run('codex', ['app-server', 'generate-ts', '--out', out])
    const inputs: Record<string, string> = {
      'codex --version': await env.run('codex', ['--version']),
      'codex --help': await env.run('codex', ['--help']),
    }
    for (const f of FILES) inputs[f] = readFileSync(join(out, f), 'utf8')
    return inputs
  },
  read: readCodexSurface,
  limitations: CODEX_LIMITATIONS,
  baseline: SURFACE_BASELINE,
}
