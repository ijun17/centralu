/**
 * The ACP update kinds and methods this adapter maps or leaves out on purpose (agent-host.md §3.1, "unmapped types"). A
 * kind outside it is logged once per session (`unmapped.ts`). `current_mode_update` and `config_option_update` are left
 * out until the model and mode menus are wired (PR 2); `user_message_chunk` is our own prompt echoed back.
 */
export const KNOWN_UPDATES: ReadonlySet<string> = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'compaction_update',
  'compaction_summary_chunk',
  'notice',
  'session/update',
  'session/request_permission',
])
