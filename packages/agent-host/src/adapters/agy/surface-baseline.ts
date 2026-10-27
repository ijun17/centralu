import type { SurfaceBaseline } from '../contract.js'

/**
 * What `agy` offered when its surface was last reviewed (#270, `contract/surface.ts`). Written by
 * `pnpm drift:surface --record`, not by hand: what the adapter limits goes in `surface.ts`'s limitations.
 */
export const SURFACE_BASELINE: SurfaceBaseline = {
  recorded: '2026-10-27',
  version: 'agy 1.4.8',
  offered: {
    command: ['agent', 'agents', 'changelog', 'help', 'install', 'mcp', 'mic-serve', 'models', 'plugin', 'plugins', 'remote-control', 'update'],
    capability: [
      '--add-dir',
      '--agent',
      '--continue',
      '--conversation',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--effort',
      '--input-format',
      '--json-schema',
      '--log-file',
      '--mode',
      '--model',
      '--new-project',
      '--output-format',
      '--print',
      '--print-timeout',
      '--project',
      '--prompt',
      '--prompt-interactive',
      '--remote-control',
      '--sandbox',
    ],
  },
}
