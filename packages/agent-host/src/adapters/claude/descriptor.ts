import type { ToolDescriptor } from '@cc/protocol'

/** Claude Code as the windows name it, with its install and sign-in commands: the adapter's descriptor, and the words a signed-out turn ends with */
export const CLAUDE_DESCRIPTOR: ToolDescriptor = {
  name: 'claude',
  label: 'Claude Code',
  mark: 'C',
  install: 'npm i -g @anthropic-ai/claude-code',
  login: 'claude auth login',
}
