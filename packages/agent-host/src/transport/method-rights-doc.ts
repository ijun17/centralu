import { METHOD_RIGHTS, type Rights } from './method-rights.js'

/**
 * docs/generated/method-rights.md: what the limited credential may call, method by method (#1405), read off
 * `METHOD_RIGHTS`. Written by `pnpm docs:rights`; a test fails while the committed file and the table disagree, so the
 * document a reviewer reads is the one the host enforces.
 */
const CLASSES: readonly { name: Exclude<Rights, object>; says: string }[] = [
  { name: 'everyday', says: 'runs' },
  { name: 'asks', says: 'refused for now; a card the person answers in the window replaces the refusal (#1405 slice 3)' },
  { name: 'window', says: "refused, never a card: the person's own answers and the window's own state" },
  { name: 'link', says: 'refused: a hub linked to this host calls it, with the token' },
  { name: 'bridge', says: "refused: a session's own tool channel, which a Codex bridge reaches with its own credential" },
]

export function renderMethodRightsDoc(): string {
  const rows: [string, Rights][] = Object.entries(METHOD_RIGHTS)
  const out: string[] = [
    '# What the limited credential may call',
    '',
    'Generated from `packages/agent-host/src/transport/method-rights.ts` by `pnpm docs:rights`; do not edit by hand.',
    'The rule behind each class is in [security-boundaries.md](../security-boundaries.md), "Who holds full power" (#1405).',
    'The token (a window, or a hub linked to this host) calls every method.',
    '',
  ]
  const named = (m: string) => `\`${m}\``
  for (const c of CLASSES) {
    const plain = rows.filter(([, r]) => r === c.name).map(([m]) => m)
    out.push(`## ${c.name}`, '', `With the limited credential: ${c.says}.`, '')
    if (c.name === 'asks') {
      const some = rows.flatMap(([m, r]) => (typeof r === 'object' ? [[m, r.when] as const] : []))
      out.push(...plain.sort().map((m) => `- ${named(m)}`))
      out.push('', 'Asks only for some parameters (everyday otherwise):', '')
      out.push(...some.sort(([a], [b]) => a.localeCompare(b)).map(([m, when]) => `- ${named(m)}, when ${when}`))
    } else {
      out.push(...plain.sort().map((m) => `- ${named(m)}`))
    }
    out.push('')
  }
  return out.join('\n')
}
