/**
 * `local/agent-adapter-checks`: an agent CLI's identity belongs to its adapter.
 *
 * Host policy asks an adapter capability (for example `instructionChannel` or `sleep`) instead
 * of comparing a tool name. The registry is the one place that enrols the adapters a build ships.
 */

const AGENT_CLI_NAMES = new Set(['claude', 'codex'])

const isAgentCliName = (node) => node?.type === 'Literal' && typeof node.value === 'string' && AGENT_CLI_NAMES.has(node.value)

export const agentAdapterChecks = {
  meta: {
    type: 'problem',
    docs: { description: 'compares an agent CLI name only inside its adapter or the adapter registry' },
    messages: {
      compare: "a comparison with agent CLI '{{name}}' belongs in its adapter or the registry; ask a capability named for what differs (docs/architecture.md §2)",
    },
    schema: [],
  },
  create(context) {
    const report = (node, name) => context.report({ node, messageId: 'compare', data: { name } })
    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return
        const literal = isAgentCliName(node.left) ? node.left : isAgentCliName(node.right) ? node.right : null
        if (literal) report(node, literal.value)
      },
      SwitchCase(node) {
        if (isAgentCliName(node.test)) report(node, node.test.value)
      },
    }
  },
}

export default { rules: { 'agent-adapter-checks': agentAdapterChecks } }
