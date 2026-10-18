import {
  SURFACE_KINDS,
  type SurfaceBaseline,
  type SurfaceKind,
  type SurfaceLimitation,
  type ToolSurface,
} from './contract/surface.js'

/**
 * The comparison behind the drift run's second direction (#270): what the tool offers now, against what someone last
 * reviewed (`baseline`) and what the adapter blocks, drops or works around (`limitations`). Pure, so the tests feed it
 * recorded surfaces; the run that reads the tool and files the issue is `scripts/surface-drift.mts`.
 *
 *   lifted  a limitation that rests on the tool not offering a name, and the tool offers it now
 *   new     offered now, and not in the baseline
 *   stale   a limitation on a name the tool offered when it was measured, and no longer offers
 *   gone    in the baseline, and no longer offered (the names the adapter uses have their own checks, #46)
 *
 * A kind the surface does not carry was not read, so nothing is said about it. `new` and `gone` also need the
 * baseline to carry the kind: the Claude adapter's command list is read only at run time, from the init message.
 */
export type SurfaceFinding =
  | { sort: 'lifted'; kind: SurfaceKind; name: string; limitation: SurfaceLimitation }
  | { sort: 'new'; kind: SurfaceKind; name: string }
  | { sort: 'stale'; kind: SurfaceKind; name: string; limitation: SurfaceLimitation }
  | { sort: 'gone'; kind: SurfaceKind; name: string }

export function compareSurface(
  surface: ToolSurface,
  limitations: readonly SurfaceLimitation[],
  baseline?: SurfaceBaseline,
): SurfaceFinding[] {
  const out: SurfaceFinding[] = []
  for (const kind of SURFACE_KINDS) {
    const now = surface.offered[kind]
    if (!now) continue
    const offered = new Set(now)
    const limited = limitations.filter((l) => l.kind === kind)
    const lifted = new Set<string>()
    const stale = new Set<string>()
    for (const l of limited) {
      if (!l.offeredWhenMeasured && !l.followsOffer && offered.has(l.name)) {
        out.push({ sort: 'lifted', kind, name: l.name, limitation: l })
        lifted.add(l.name)
      }
      if (l.offeredWhenMeasured && !offered.has(l.name)) {
        out.push({ sort: 'stale', kind, name: l.name, limitation: l })
        stale.add(l.name)
      }
    }
    const then = baseline?.offered[kind]
    if (!then) continue
    const seen = new Set(then)
    for (const name of [...offered].sort()) {
      if (!seen.has(name) && !lifted.has(name)) out.push({ sort: 'new', kind, name })
    }
    for (const name of [...seen].sort()) {
      if (!offered.has(name) && !stale.has(name)) out.push({ sort: 'gone', kind, name })
    }
  }
  return out
}

/** A key that stays the same while the findings do, so a weekly run can tell an issue it already filed */
export function findingsKey(findings: readonly SurfaceFinding[]): string {
  return findings
    .map((f) => `${f.sort}:${f.kind}:${f.name}`)
    .sort()
    .join('\n')
}

const SECTIONS: { sort: SurfaceFinding['sort']; title: string; why: string }[] = [
  {
    sort: 'lifted',
    title: 'May no longer be limited',
    why: 'The adapter limits these because the tool did not offer them when measured. It offers them now: measure again, and lift the limitation if it holds.',
  },
  {
    sort: 'new',
    title: 'New since the baseline',
    why: 'Sort each into "the adapter must change", "the screen should show it" or "nothing".',
  },
  {
    sort: 'stale',
    title: 'Limitations on names the tool no longer offers',
    why: 'The entry outlived what it describes: check the adapter still needs its workaround, then remove or re-measure it.',
  },
  {
    sort: 'gone',
    title: 'No longer offered',
    why: 'Recorded in the baseline, missing now. The names the adapter itself uses have their own drift checks (#46).',
  },
]

const line = (f: SurfaceFinding): string => {
  const head = `- ${f.kind} \`${f.name}\``
  if (f.sort === 'lifted' || f.sort === 'stale') {
    const l = f.limitation
    return `${head}: ${l.treatment} (measured ${l.measured}). ${l.note}`
  }
  return head
}

/** The issue body: what was read, against what, and each sort of finding with what to do about it */
export function surfaceReport(
  tool: string,
  surface: ToolSurface,
  baseline: SurfaceBaseline | undefined,
  findings: readonly SurfaceFinding[],
): string {
  const parts = [
    `Read from the latest published ${tool}: ${surface.version}.`,
    baseline ? `Baseline: ${baseline.version}, recorded ${baseline.recorded}.` : 'No baseline recorded yet.',
  ]
  for (const s of SECTIONS) {
    const these = findings.filter((f) => f.sort === s.sort)
    if (these.length === 0) continue
    parts.push(`### ${s.title} (${these.length})`, s.why, these.map(line).join('\n'))
  }
  parts.push(
    `When they are sorted: update \`limitations\` in \`adapters/${tool}/surface.ts\` and run \`pnpm drift:surface --record\` ` +
      'in the same pull request, so the next run starts from what was reviewed (#270).',
  )
  return parts.join('\n\n')
}

/**
 * The text of `adapters/<tool>/surface-baseline.ts` for a reading: what `pnpm drift:surface --record` writes. One name
 * per line, sorted, so a re-recorded baseline's diff is the list of what changed.
 */
const quoted = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export function baselineSource(surface: ToolSurface, recorded: string): string {
  const lists = SURFACE_KINDS.flatMap((kind) => {
    const names = surface.offered[kind]
    if (!names) return []
    return [`    ${kind}: [\n${[...names].sort().map((n) => `      ${quoted(n)},\n`).join('')}    ],\n`]
  })
  return (
    "import type { SurfaceBaseline } from '../contract.js'\n\n" +
    '/**\n' +
    ' * What the tool offered when its surface was last reviewed (#270, `contract/surface.ts`). Written by\n' +
    " * `pnpm drift:surface --record`, not by hand: what the adapter limits goes in `surface.ts`'s limitations.\n" +
    ' */\n' +
    'export const SURFACE_BASELINE: SurfaceBaseline = {\n' +
    `  recorded: '${recorded}',\n` +
    `  version: ${quoted(surface.version)},\n` +
    '  offered: {\n' +
    lists.join('') +
    '  },\n' +
    '}\n'
  )
}

/**
 * One host.log line per finding, for a surface an adapter reads at run time (the Claude adapter's init message, #270).
 * Only `lifted` and `stale` can be told there; the baseline is the drift run's.
 */
export function surfaceLogLines(tool: string, sessionId: string, findings: readonly SurfaceFinding[]): string[] {
  return findings
    .filter((f) => f.sort === 'lifted' || f.sort === 'stale')
    .map((f) =>
      `[${tool}] ${sessionId.slice(0, 8)} ` +
      (f.sort === 'lifted'
        ? `the tool now offers ${f.kind} ${f.name}, which the adapter ${f.limitation.treatment === 'blocked' ? 'blocks' : f.limitation.treatment === 'dropped' ? 'drops' : 'works around'} (measured ${f.limitation.measured}); it may no longer need to`
        : `the tool no longer offers ${f.kind} ${f.name}; the adapter's limitation on it (measured ${f.limitation.measured}) is stale`),
    )
}
