import type { SurfaceBaseline } from '../contract.js'

/**
 * What the tool offered when its surface was last reviewed (#270, `contract/surface.ts`). Written by
 * `pnpm drift:surface --record`, not by hand: what the adapter limits goes in `surface.ts`'s limitations.
 */
export const SURFACE_BASELINE: SurfaceBaseline = {
  recorded: '2026-10-26',
  version: 'agent 2026.10.22-27dcf5f',
  offered: {
    command: [
      'about',
      'agent',
      'bedrock',
      'create-chat',
      'cursor/ask_question',
      'cursor/create_plan',
      'cursor/generate_image',
      'cursor/list_available_models',
      'cursor/task',
      'cursor/update_todos',
      'help',
      'login',
      'logout',
      'ls',
      'mcp',
      'models',
      'persist',
      'plugin',
      'prompt',
      'resume',
      'team',
      'update',
      'worker',
    ],
    message: [
      'agent_message_chunk',
      'agent_thought_chunk',
      'available_commands_update',
      'current_mode_update',
      'plan',
      'session_info_update',
      'subagent_spawned',
      'subagent_state_update',
      'tool_call',
      'tool_call_update',
      'user_message_chunk',
    ],
    capability: [
      'authMethods.cursor_login',
      'loadSession',
      'mcpCapabilities.http',
      'mcpCapabilities.sse',
      'promptCapabilities.audio',
      'promptCapabilities.embeddedContext',
      'promptCapabilities.image',
      'sessionCapabilities.list',
    ],
  },
}
