/** `agent/agent-adapter-checks`: an agent CLI's identity belongs to its adapter. */
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Read the identities from the adapters enrolled by the registry, without loading adapters
// (and their SDKs/native modules) into ESLint or keeping a second vendor list here.
const registryUrl = new URL('../packages/agent-host/src/adapters/registry.ts', import.meta.url)
const sourceOf = (url) => ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true)
const AGENT_CLI_NAMES = new Set()
for (const statement of sourceOf(registryUrl).statements) {
  if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue
  const adapterUrl = new URL(statement.moduleSpecifier.text.replace(/\.js$/, '.ts'), registryUrl)
  for (const declaration of sourceOf(adapterUrl).statements) {
    if (!ts.isClassDeclaration(declaration)) continue
    for (const member of declaration.members) {
      if (!ts.isPropertyDeclaration(member) || member.name.getText() !== 'tool') continue
      let value = member.initializer
      while (value && (ts.isAsExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression
      if (value && ts.isStringLiteralLike(value)) AGENT_CLI_NAMES.add(value.text)
    }
  }
}

export const agentAdapterChecks = {
  meta: {
    type: 'problem',
    docs: { description: 'keeps agent CLI identities inside adapters and the registry' },
    messages: {
      identity: "agent CLI '{{name}}' belongs in its adapter or the registry; ask a capability named for what differs (docs/architecture.md §2)",
    },
    schema: [],
  },
  create(context) {
    const report = (node, name) => {
      if (AGENT_CLI_NAMES.has(name)) context.report({ node, messageId: 'identity', data: { name } })
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') report(node, node.value)
        // An exact-name regexp is the same identity check as a string comparison.
        else if (node.regex) report(node, node.regex.pattern.replace(/^\^|\$$/g, ''))
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0) report(node, node.quasis[0].value.cooked)
      },
      Property(node) {
        if (!node.computed && node.key.type === 'Identifier') report(node.key, node.key.name)
      },
    }
  },
}

export default { rules: { 'agent-adapter-checks': agentAdapterChecks } }
