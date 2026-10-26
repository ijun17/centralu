import type { SurfaceBaseline } from '../contract.js'

/**
 * What the tool offered when its surface was last reviewed (#270, `contract/surface.ts`). Written by
 * `pnpm drift:surface --record`, not by hand: what the adapter limits goes in `surface.ts`'s limitations.
 */
export const SURFACE_BASELINE: SurfaceBaseline = {
  recorded: '2026-10-25',
  version: 'opencode 1.19.4',
  offered: {
    command: [
      'acp',
      'agent',
      'attach',
      'completion',
      'db',
      'debug',
      'export',
      'github',
      'import',
      'mcp',
      'models',
      'plugin',
      'pr',
      'providers',
      'run',
      'serve',
      'session',
      'stats',
      'uninstall',
      'upgrade',
      'web',
    ],
    message: [
      'agent_message_chunk',
      'agent_thought_chunk',
      'available_commands_update',
      'config_option_update',
      'tool_call',
      'tool_call_update',
      'usage_update',
    ],
    capability: [
      'authMethods.opencode-login',
      'loadSession',
      'mcpCapabilities.http',
      'mcpCapabilities.sse',
      'promptCapabilities.embeddedContext',
      'promptCapabilities.image',
      'sessionCapabilities.close',
      'sessionCapabilities.fork',
      'sessionCapabilities.list',
      'sessionCapabilities.resume',
    ],
  },
}
