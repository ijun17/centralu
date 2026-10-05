import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  SessionInfo,
  sessionLiveDefaults,
  type GridPanel,
  type NormalizedEvent,
  type StoredMessage,
  type ToolName,
} from '@cc/protocol'
import { toolSummary } from '../../packages/agent-host/src/adapters/claude/normalize.js'
import { Store } from '../../packages/agent-host/src/dev-services/store.js'

/**
 * A store that looks like one somebody has used for months, for measuring what Centralu costs
 * (#364 "Performance"). Based on `measure/seed.mts` by GyuHo123 in #400 (one project, one long
 * session and five ordinary ones); this one is parameterised and shaped after a real store.
 *
 * The shape comes from counting one real store (2026-10, about 20 sessions): roughly 61k tool
 * calls, 61k tool results, 20k assistant texts, 10k reasoning rows and a few dozen images. So a
 * turn here is a person's message, then mostly tool calls with their results, a text every few
 * calls and some reasoning. Tool output follows each tool's usual size (a Read is long, an Edit
 * short), capped at 50 KB as the tools cap it; the card's `summary` is its first 300 characters,
 * as the Claude adapter writes it. A few calls launch a subagent whose steps go to their own
 * table, a few ask for approval, long sessions are compacted now and then, and images are real
 * PNG files under the data folder's `attachments/`, the way the host keeps them.
 *
 * Everything is deterministic: one seeded generator, fixed timestamps, so two runs with the same
 * profile, seed and folder write the same rows. Nothing here reads the clock or `Math.random`. The
 * folder is part of the content (tool inputs name files under its projects), so another folder
 * moves the counts by a fraction of a percent.
 *
 * It writes only into the folder it is given, and refuses a folder that already holds a store.
 * Never point it at a real data folder (`~/.centralu`).
 */

export type StoreProfile = 'small' | 'owner' | 'stress'

type ProfileSpec = {
  /** Row targets, one per session, longest first. The first is the "long session" scenarios open */
  sessions: number[]
  projects: number
  /** Agent images (screenshots) over the whole store */
  images: number
  /** Session panels in the saved grid */
  gridPanels: number
  /** Rows in the app-run log */
  appRuns: number
}

export const PROFILES: Record<StoreProfile, ProfileSpec> = {
  // About the store #400 measured: one long session, five ordinary ones
  small: { sessions: [2_100, 180, 180, 180, 180, 180], projects: 1, images: 2, gridPanels: 4, appRuns: 20 },
  // About the owner's store: ~150k rows over 24 sessions, the longest 20k
  owner: {
    sessions: [
      20_000, 16_000, 14_000, 12_000, 10_000, 9_000, 8_000, 8_000, 7_000, 6_000, 6_000, 5_000, 5_000, 4_000,
      4_000, 3_000, 3_000, 2_500, 2_000, 1_500, 1_200, 800, 400, 150,
    ],
    projects: 4,
    images: 40,
    gridPanels: 6,
    appRuns: 400,
  },
  // Several times that: ~350k rows over 60 sessions
  stress: {
    sessions: [
      ...Array.from({ length: 2 }, () => 50_000),
      ...Array.from({ length: 4 }, () => 20_000),
      ...Array.from({ length: 14 }, () => 8_000),
      ...Array.from({ length: 40 }, () => 1_500),
    ],
    projects: 8,
    images: 120,
    gridPanels: 9,
    appRuns: 2_000,
  },
}

export type SeededSession = {
  id: string
  name: string
  projectId: string
  tool: ToolName
  rows: number
  lastSeq: number
}

export type SeedSummary = {
  profile: StoreProfile
  seed: number
  dataDir: string
  db: string
  projects: { id: string; name: string; path: string }[]
  sessions: SeededSession[]
  /** The longest session — the one the scenarios open */
  longSessionId: string
  gridSessionIds: string[]
  rowsByKind: Record<string, number>
  toolsByName: Record<string, number>
  /** Bytes of the full tool output kept in the store (never sent to the window) */
  toolOutputBytes: number
  subagentLaunches: number
  subagentSteps: number
  approvals: number
  appRuns: number
  images: number
  imageBytes: number
  dbBytes: number
}

// ── A seeded generator ─────────────────────────────────────────────────────────────────────

/** mulberry32: small, fast, and the same sequence on every platform */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Gen {
  constructor(readonly next: () => number) {}
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!
  }
  /** Picks by weight: `[[value, weight], …]` */
  weighted<T>(xs: readonly (readonly [T, number])[]): T {
    const total = xs.reduce((s, [, w]) => s + w, 0)
    let r = this.next() * total
    for (const [v, w] of xs) {
      r -= w
      if (r < 0) return v
    }
    return xs[xs.length - 1]![0]
  }
  /** A log-normal size: `median` in the middle, `spread` its sigma, clamped to [lo, hi] */
  size(median: number, spread: number, lo: number, hi: number): number {
    const u = Math.max(this.next(), 1e-9)
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next())
    return Math.round(Math.min(hi, Math.max(lo, median * Math.exp(spread * z))))
  }
}

// ── Material: words, paths, code, command output ──────────────────────────────────────────

const WORDS = (
  'the host keeps conversation window draws again after every restart session store event panel grid focus ' +
  'approval agent tool result call output message reasoning keeper relay socket token buffer memory trim ' +
  'virtual scroller row height measure layout render commit react state selector reducer migration index ' +
  'search query worker orchestrator project branch worktree merge review test fails passes because when ' +
  'while before after only never always which where that this those these with without into from over ' +
  'under between page history cursor offset seq frame queue drain flush write read close open launch'
).split(' ')

const DIRS = [
  'packages/ui/src/store',
  'packages/ui/src/features/session',
  'packages/ui/src/features/grid',
  'packages/ui/src/features/sidebar',
  'packages/agent-host/src/sessions',
  'packages/agent-host/src/dev-services',
  'packages/agent-host/src/adapters/claude',
  'packages/agent-host/src/adapters/codex',
  'packages/protocol/src',
  'packages/platform/src/web',
  'apps/desktop/src-tauri/src/keeper',
  'docs',
  'e2e',
]
const FILES = [
  'store.ts',
  'SessionView.tsx',
  'GridView.tsx',
  'Sidebar.tsx',
  'manager.ts',
  'store.test.ts',
  'normalize.ts',
  'index.ts',
  'events.ts',
  'commands.ts',
  'rpc-client.ts',
  'relay.rs',
  'agent-host.md',
  'panel.spec.ts',
  'history.ts',
  'scroll.ts',
]

const CODE = [
  "import { useStore } from '../../store/store'",
  'export function appendChat(items: ChatItem[], e: NormalizedEvent): ChatItem[] {',
  '  const last = items[items.length - 1]',
  "  if (e.type === 'message_delta' && last?.kind === 'assistant') {",
  '    return [...items.slice(0, -1), { ...last, text: last.text + e.text }]',
  '  }',
  '  return items',
  '}',
  '',
  '  /*',
  '   * The off-screen window: a session nobody looks at keeps its last page only.',
  '   */',
  '  const virtualizer = useVirtualizer({ count: chat.length, getScrollElement: () => scrollRef.current, estimateSize })',
  "    this.store.appendMessages([{ sessionId, seq, role: 'system', kind, payload, ts: Date.now() }])",
  '    if (!m) return null',
  '  for (const row of rows) {',
  '    const payload = JSON.parse(row.payload) as Record<string, unknown>',
  "  expect(screen.getByTestId('chat-stream')).toBeVisible()",
  "  it('keeps the focused session whole', async () => {",
  '    await act(() => store.getState().focusSession(id))',
  '  })',
  'fn drop_front(&mut self, n: usize) {',
  '    self.buf.drain(..n);',
  '    if self.buf.capacity() > KEEP && self.buf.len() < KEEP / 4 { self.buf.shrink_to(KEEP) }',
  '}',
  'type Props = { sessionId: string; compact?: boolean }',
  'const HISTORY_PAGE = 100',
  '    return { ...s, chat: { ...s.chat, [id]: trimmed }, history: { ...s.history, [id]: cursor } }',
  '      .prepare(`SELECT seq, kind, payload FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)',
  '      .all(sessionId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)',
]

const COMMANDS = [
  'pnpm exec vitest run --maxWorkers=4 packages/ui/src/store/store.test.ts',
  'pnpm verify',
  'git status --short',
  'git diff --stat',
  'git diff',
  'git log --oneline -20',
  "rg -n 'focusSession' packages/ui/src",
  "rg -n 'appendMessages' packages/agent-host/src",
  'ls -la packages/ui/src/features/session',
  'pnpm typecheck',
  'pnpm lint',
  'gh pr view 393 --json title,body,files',
  'gh pr checks',
  'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib',
  'CI=1 pnpm e2e e2e/panel.spec.ts',
  'node --import tsx packages/agent-host/scripts/smoke.mjs',
  "sqlite3 /tmp/store.db 'select kind, count(*) from messages group by kind'",
]

type ToolName2 =
  | 'Bash'
  | 'Read'
  | 'Edit'
  | 'Grep'
  | 'Glob'
  | 'Write'
  | 'TodoWrite'
  | 'WebFetch'
  | 'Agent'
  | 'mcp__centralu__read_session'

// Roughly how often each tool is called in a Claude Code session
const TOOL_MIX: (readonly [ToolName2, number])[] = [
  ['Bash', 36],
  ['Read', 25],
  ['Edit', 15],
  ['Grep', 8],
  ['Glob', 3],
  ['Write', 3],
  ['TodoWrite', 4],
  ['WebFetch', 1],
  ['mcp__centralu__read_session', 1],
]

/** One block of pseudo-prose made once, sliced for every text — generating every text word by word is too slow */
function corpus(g: Gen, chars: number): string {
  const out: string[] = []
  let n = 0
  while (n < chars) {
    const len = g.int(6, 22)
    const words = Array.from({ length: len }, () => g.pick(WORDS))
    const s = words.join(' ')
    const sentence = s.charAt(0).toUpperCase() + s.slice(1) + '. '
    out.push(sentence)
    n += sentence.length
  }
  return out.join('')
}

class Material {
  private prose: string
  constructor(private g: Gen) {
    this.prose = corpus(g, 256 * 1024)
  }
  text(len: number): string {
    const at = this.g.int(0, this.prose.length - len - 1)
    return this.prose.slice(at, at + len)
  }
  path(): string {
    return `${this.g.pick(DIRS)}/${this.g.pick(FILES)}`
  }
  codeLines(n: number, from = 1): string {
    const out: string[] = []
    for (let i = 0; i < n; i++) out.push(`${String(from + i).padStart(6)}\t${this.g.pick(CODE)}`)
    return out.join('\n')
  }
  /** Markdown as the agents write it: paragraphs, sometimes a list, sometimes a code block */
  markdown(len: number): string {
    const parts: string[] = []
    let n = 0
    while (n < len) {
      const r = this.g.next()
      let part: string
      if (r < 0.15)
        part =
          '```ts\n' + Array.from({ length: this.g.int(3, 14) }, () => this.g.pick(CODE)).join('\n') + '\n```'
      else if (r < 0.35)
        part = Array.from(
          { length: this.g.int(2, 6) },
          () => `- \`${this.path()}\`: ${this.text(this.g.int(40, 140))}`,
        ).join('\n')
      else part = this.text(this.g.int(120, 600))
      parts.push(part)
      n += part.length
    }
    return parts.join('\n\n')
  }
  /** Fills to `len` with lines made by `line` */
  lines(len: number, line: (i: number) => string): string {
    const out: string[] = []
    let n = 0
    for (let i = 0; n < len; i++) {
      const l = line(i)
      out.push(l)
      n += l.length + 1
    }
    return out.join('\n').slice(0, len)
  }
}

type Call = { tool: ToolName2; input: Record<string, unknown>; output: string; ok: boolean }

function makeCall(g: Gen, m: Material, tool: ToolName2, cwd: string): Call {
  switch (tool) {
    case 'Bash': {
      const command = g.pick(COMMANDS)
      const len = g.size(900, 1.4, 20, 50_000)
      const output =
        command.startsWith('pnpm exec vitest') || command.includes('e2e')
          ? m.lines(len, (i) =>
              i % 9 === 8
                ? ` ✓ ${m.path()} (${g.int(1, 140)} tests) ${g.int(20, 4000)}ms`
                : `   ✓ ${m.text(g.int(30, 90))}`,
            )
          : command.startsWith('git diff')
            ? m.lines(len, (i) =>
                i % 12 === 0 ? `@@ -${i},7 +${i},9 @@` : `${g.pick([' ', '+', '-'])}${g.pick(CODE)}`,
              )
            : command.startsWith('rg')
              ? m.lines(len, () => `${m.path()}:${g.int(1, 6000)}:${g.pick(CODE)}`)
              : m.lines(len, () => m.text(g.int(30, 120)))
      return { tool, input: { command, description: m.text(g.int(20, 60)) }, output, ok: g.chance(0.9) }
    }
    case 'Read': {
      const file_path = `${cwd}/${m.path()}`
      const len = g.size(6_000, 1.0, 200, 50_000)
      const from = g.int(1, 3000)
      return {
        tool,
        input: { file_path, offset: from, limit: 400 },
        output: m.lines(len, (i) => m.codeLines(1, from + i)),
        ok: true,
      }
    }
    case 'Edit': {
      const file_path = `${cwd}/${m.path()}`
      const old_string = Array.from({ length: g.int(1, 12) }, () => g.pick(CODE)).join('\n')
      const new_string = Array.from({ length: g.int(1, 20) }, () => g.pick(CODE)).join('\n')
      const output = `The file ${file_path} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${m.codeLines(g.int(4, 16), g.int(1, 2000))}`
      return { tool, input: { file_path, old_string, new_string }, output, ok: g.chance(0.95) }
    }
    case 'Write': {
      const file_path = `${cwd}/${m.path()}`
      const content = Array.from({ length: g.int(20, 300) }, () => g.pick(CODE)).join('\n')
      return {
        tool,
        input: { file_path, content },
        output: `File created successfully at: ${file_path}`,
        ok: true,
      }
    }
    case 'Grep': {
      const pattern = g.pick(WORDS)
      return {
        tool,
        input: { pattern, path: cwd, output_mode: 'content' },
        output: m.lines(
          g.size(1_500, 1.1, 30, 30_000),
          () => `${m.path()}:${g.int(1, 6000)}:${g.pick(CODE)}`,
        ),
        ok: true,
      }
    }
    case 'Glob': {
      const pattern = `**/*${g.pick(['.ts', '.tsx', '.md', '.rs'])}`
      return {
        tool,
        input: { pattern },
        output: m.lines(g.size(800, 0.8, 30, 10_000), () => `${cwd}/${m.path()}`),
        ok: true,
      }
    }
    case 'TodoWrite': {
      const todos = Array.from({ length: g.int(3, 9) }, () => ({
        content: m.text(g.int(20, 70)),
        status: g.pick(['pending', 'in_progress', 'completed']),
        activeForm: m.text(20),
      }))
      return {
        tool,
        input: { todos },
        output:
          'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.',
        ok: true,
      }
    }
    case 'WebFetch': {
      return {
        tool,
        input: { url: `https://docs.example.org/${g.pick(WORDS)}`, prompt: m.text(60) },
        output: m.markdown(g.size(4_000, 0.8, 300, 30_000)),
        ok: true,
      }
    }
    case 'mcp__centralu__read_session': {
      return {
        tool,
        input: { sessionId: `s-${g.int(1, 30)}` },
        output: m.markdown(g.size(3_000, 0.8, 200, 30_000)),
        ok: true,
      }
    }
    case 'Agent': {
      return {
        tool,
        input: {
          description: m.text(g.int(20, 50)),
          prompt: m.markdown(g.int(300, 1500)),
          subagent_type: 'general-purpose',
        },
        output: m.markdown(g.size(2_000, 0.6, 300, 12_000)),
        ok: true,
      }
    }
  }
}

// ── Images ─────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/**
 * A screenshot-like PNG: flat panels and text-like stripes with some noise, so it compresses about as badly as a
 * real screenshot (a few hundred KB at 1440×900) instead of to nothing.
 */
export function screenshotPng(seed: number, width: number, height: number): Buffer {
  return drawPng(new Gen(rng(seed)), width, height)
}

function drawPng(g: Gen, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  const panels = Array.from({ length: 6 }, () => ({
    x: g.int(0, width),
    y: g.int(0, height),
    w: g.int(80, width / 2),
    h: g.int(60, height / 2),
    c: [g.int(20, 240), g.int(20, 240), g.int(20, 240)],
  }))
  const noise = rng(g.int(1, 1 << 30))
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    const textRow = y % 18 < 11
    for (let x = 0; x < width; x++) {
      let r = 246
      let gr = 246
      let b = 248
      for (const p of panels) {
        if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) {
          r = p.c[0]!
          gr = p.c[1]!
          b = p.c[2]!
        }
      }
      if (textRow && (x >> 3) % 7 !== 0 && noise() < 0.35) {
        const v = Math.floor(noise() * 90)
        r = v
        gr = v
        b = v
      }
      const o = row + 1 + x * 3
      raw[o] = r
      raw[o + 1] = gr
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── The seeding itself ─────────────────────────────────────────────────────────────────────

/** 2026-09-01T00:00:00Z — every timestamp counts from here, so a seed never depends on when it ran */
const T0 = Date.UTC(2026, 8, 1)

export function seedHeavyStore(dataDir: string, profile: StoreProfile = 'owner', seed = 1): SeedSummary {
  const spec = PROFILES[profile]
  const db = join(dataDir, 'store.db')
  let exists = false
  try {
    statSync(db)
    exists = true
  } catch {
    // No store yet — the only case this writes into
  }
  if (exists) throw new Error(`${db} already exists; the fixture only writes a fresh store`)
  mkdirSync(dataDir, { recursive: true })

  const g = new Gen(rng(seed))
  const m = new Material(g)
  const store = new Store(db)
  let summary: SeedSummary
  const rowsByKind: Record<string, number> = {}
  const toolsByName: Record<string, number> = {}
  let toolOutputBytes = 0
  let subagentLaunches = 0
  let subagentSteps = 0
  let approvals = 0
  let images = 0
  let imageBytes = 0

  try {
    const projectNames = [
      'centralu',
      'game-client',
      'tools',
      'website',
      'infra',
      'notes',
      'mobile',
      'research',
    ]
    const projects = Array.from({ length: spec.projects }, (_, i) => {
      const name = projectNames[i % projectNames.length]! + (i >= projectNames.length ? `-${i}` : '')
      const path = join(dataDir, 'projects', name)
      mkdirSync(path, { recursive: true })
      const p = { id: `p${i + 1}`, name, path }
      store.addProject(p)
      return p
    })

    // Images go to sessions in proportion to their length, a few of them near the end of the long one so the page
    // a person opens has some in it
    const total = spec.sessions.reduce((a, b) => a + b, 0)
    const imagesFor = spec.sessions.map((n) => Math.floor((spec.images * n) / total))
    imagesFor[0] = (imagesFor[0] ?? 0) + spec.images - imagesFor.reduce((a, b) => a + b, 0)

    const sessions: SeededSession[] = []
    spec.sessions.forEach((target, si) => {
      // The first project holds most of the work, as one person's main repository does
      const project =
        si < spec.sessions.length / 2
          ? projects[0]!
          : (projects[1 + (si % Math.max(1, projects.length - 1))] ?? projects[0]!)
      const id = `perf-${String(si + 1).padStart(2, '0')}`
      const tool: ToolName = si % 7 === 3 ? 'codex' : 'claude'
      const name = si === 0 ? 'A long conversation' : m.text(g.int(14, 40)).replace(/\.\s*$/, '')
      const createdAt = T0 + si * 3_600_000
      const info = (lastSeq: number, lastReadSeq: number) =>
        SessionInfo.parse({
          id,
          projectId: project.id,
          kind: 'worker',
          tool,
          externalId: null,
          name,
          autoNamed: false,
          state: 'idle',
          live: false,
          createdAt,
          lastSeq,
          lastReadSeq,
          ...sessionLiveDefaults(),
        })
      // The row goes in first: a subagent's steps refer to their session
      store.upsertSession(info(0, 0))
      const s = seedSession(store, g, m, {
        id,
        projectId: project.id,
        cwd: project.path,
        tool,
        name,
        createdAt,
        target,
        images: imagesFor[si] ?? 0,
        imagesNearEnd: si === 0 ? Math.min(3, imagesFor[0] ?? 0) : 0,
        dataDir,
      })
      for (const [k, v] of Object.entries(s.rowsByKind)) rowsByKind[k] = (rowsByKind[k] ?? 0) + v
      for (const [k, v] of Object.entries(s.toolsByName)) toolsByName[k] = (toolsByName[k] ?? 0) + v
      toolOutputBytes += s.toolOutputBytes
      subagentLaunches += s.subagentLaunches
      subagentSteps += s.subagentSteps
      approvals += s.approvals
      images += s.images
      imageBytes += s.imageBytes
      // Most are read; every fourth has a few unread rows, as a morning's sidebar does
      store.upsertSession(info(s.lastSeq, si % 4 === 1 ? Math.max(0, s.lastSeq - g.int(3, 40)) : s.lastSeq))
      sessions.push({ id, name, projectId: project.id, tool, rows: s.rows, lastSeq: s.lastSeq })
    })

    const gridSessionIds = sessions.slice(0, spec.gridPanels).map((s) => s.id)
    store.setGridView(gridSessionIds.map((sessionId): GridPanel => ({ kind: 'session', sessionId })))

    for (let i = 0; i < spec.appRuns; i++) {
      const id = `run-${i + 1}`
      const createdAt = T0 + i * 600_000
      store.beginAppRun({
        id,
        projectId: projects[0]!.id,
        appId: g.pick(['project-board', 'notes', 'release-check']),
        kind: g.pick(['tool', 'tool', 'tool', 'run_agent']),
        tool: g.pick(['list_items', 'set_item_fields', 'add_item', 'run_status']),
        callerKind: g.pick(['session', 'app']),
        callerSessionId: sessions[i % sessions.length]!.id,
        parentRunId: null,
        status: 'running',
        durationMs: null,
        argsDigest: `d${i}`,
        argsSummary: m.text(g.int(20, 120)),
        error: null,
        createdAt,
        sessionId: null,
      })
      store.endAppRun(id, {
        status: g.chance(0.93) ? 'ok' : 'error',
        durationMs: g.int(5, 40_000),
        error: null,
      })
    }

    summary = {
      profile,
      seed,
      dataDir,
      db,
      projects,
      sessions,
      longSessionId: sessions[0]!.id,
      gridSessionIds,
      rowsByKind,
      toolsByName,
      toolOutputBytes,
      subagentLaunches,
      subagentSteps,
      approvals,
      appRuns: spec.appRuns,
      images,
      imageBytes,
      dbBytes: 0,
    }
  } finally {
    store.close()
  }
  // Measured after `close`, which folds the WAL into the file
  return { ...summary, dbBytes: statSync(db).size }
}

type SessionSeed = {
  id: string
  projectId: string
  cwd: string
  tool: ToolName
  name: string
  createdAt: number
  target: number
  images: number
  imagesNearEnd: number
  dataDir: string
}

function seedSession(store: Store, g: Gen, m: Material, s: SessionSeed) {
  const rowsByKind: Record<string, number> = {}
  const toolsByName: Record<string, number> = {}
  let toolOutputBytes = 0
  let subagentLaunches = 0
  let subagentSteps = 0
  let approvals = 0
  let images = 0
  let imageBytes = 0
  let seq = 0
  let ts = s.createdAt
  let batch: StoredMessage[] = []
  const flush = () => {
    if (batch.length) store.appendMessages(batch)
    batch = []
  }
  const push = (role: StoredMessage['role'], kind: StoredMessage['kind'], payload: unknown) => {
    ts += g.int(200, 20_000)
    batch.push({ sessionId: s.id, seq: ++seq, role, kind, payload, ts })
    // A person's text is counted apart from the agent's
    const key = role === 'user' ? 'user' : kind
    rowsByKind[key] = (rowsByKind[key] ?? 0) + 1
    if (batch.length >= 2_000) flush()
  }
  // Where the images go: spread over the session, plus a few in its last page. Each lands after the first tool
  // result at or past its spot, the way a screenshot follows the call that took it
  const imageAt: number[] = []
  for (let i = 0; i < s.images - s.imagesNearEnd; i++) imageAt.push(g.int(1, Math.max(1, s.target - 300)))
  for (let i = 0; i < s.imagesNearEnd; i++) imageAt.push(s.target - 60 + i * 15)
  imageAt.sort((a, b) => a - b)
  const writeImage = () => {
    const png = drawPng(g, g.pick([1280, 1440, 1600]), g.pick([800, 900, 1000]))
    const dir = join(s.dataDir, 'attachments', s.id)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${ts}-${images}.png`)
    writeFileSync(path, png)
    images++
    imageBytes += png.length
    const payload: NormalizedEvent = {
      type: 'message_image',
      sessionId: s.id,
      mime: 'image/png',
      data: '',
      path,
    }
    push('system', 'image', payload)
  }

  while (seq < s.target) {
    // A person's message
    push('user', 'text', { text: m.text(g.size(220, 1.0, 12, 4_000)) })
    if (g.chance(0.5))
      push('assistant', 'reasoning', {
        type: 'reasoning_delta',
        sessionId: s.id,
        text: m.text(g.size(500, 0.8, 60, 4_000)),
      })
    if (g.chance(0.6))
      push('assistant', 'text', {
        type: 'message_delta',
        sessionId: s.id,
        role: 'assistant',
        text: m.markdown(g.size(260, 0.8, 30, 2_000)),
      })
    const calls = g.size(11, 0.9, 1, 120)
    for (let c = 0; c < calls && seq < s.target; c++) {
      if (g.chance(0.12))
        push('assistant', 'reasoning', {
          type: 'reasoning_delta',
          sessionId: s.id,
          text: m.text(g.size(400, 0.8, 40, 3_000)),
        })
      const launch = g.chance(0.004)
      const tool: ToolName2 = launch ? 'Agent' : g.weighted(TOOL_MIX)
      const call = makeCall(g, m, tool, s.cwd)
      const callId = `toolu_${s.id}_${seq + 1}`
      toolsByName[tool] = (toolsByName[tool] ?? 0) + 1
      push('system', 'tool_call', {
        type: 'tool_call',
        sessionId: s.id,
        callId,
        summary: toolSummary(tool, call.input),
        input: call.input,
      })
      if (launch) {
        subagentLaunches++
        subagentSteps += seedSubagent(store, g, m, s, callId, ts)
      }
      // A command that needed the person's yes
      if (tool === 'Bash' && g.chance(0.03)) {
        const requestId = `req-${s.id}-${seq}`
        const command = (call.input as { command: string }).command
        push('system', 'approval', {
          type: 'approval_request',
          sessionId: s.id,
          requestId,
          detail: { kind: 'command', command, cwd: s.cwd },
        })
        push('system', 'approval', {
          type: 'approval_resolved',
          sessionId: s.id,
          requestId,
          decision: g.pick(['allow', 'allow', 'always', 'deny']),
        })
        approvals++
      }
      toolOutputBytes += call.output.length
      push('system', 'tool_result', {
        type: 'tool_result',
        sessionId: s.id,
        callId,
        ok: call.ok,
        summary: call.output.slice(0, 300),
        output: call.output,
      })
      while (imageAt.length && imageAt[0]! <= seq) {
        imageAt.shift()
        writeImage()
      }
      if (g.chance(0.22))
        push('assistant', 'text', {
          type: 'message_delta',
          sessionId: s.id,
          role: 'assistant',
          text: m.markdown(g.size(300, 0.9, 30, 3_000)),
        })
    }
    push('assistant', 'text', {
      type: 'message_delta',
      sessionId: s.id,
      role: 'assistant',
      text: m.markdown(g.size(900, 0.8, 80, 8_000)),
    })
    // A long session is compacted every few thousand rows
    if (s.target > 3_000 && g.chance(0.012))
      push('system', 'marker', { type: 'compaction', sessionId: s.id, failed: false })
  }
  // An image whose spot came after the last tool result still belongs to this session
  for (const _ of imageAt) writeImage()
  flush()
  return {
    rows: seq,
    lastSeq: seq,
    rowsByKind,
    toolsByName,
    toolOutputBytes,
    subagentLaunches,
    subagentSteps,
    approvals,
    images,
    imageBytes,
  }
}

/** The steps of one subagent launch: ~80 tool calls with their results and a few texts (#222's measured average) */
function seedSubagent(
  store: Store,
  g: Gen,
  m: Material,
  s: SessionSeed,
  parentCallId: string,
  ts: number,
): number {
  const calls = g.size(80, 0.6, 5, 400)
  let steps = 0
  const put = (kind: StoredMessage['kind'], role: StoredMessage['role'], payload: unknown) => {
    store.appendSubagentMessage(s.id, parentCallId, { role, kind, payload, ts: ts + steps })
    steps++
  }
  for (let i = 0; i < calls; i++) {
    if (g.chance(0.15))
      put('text', 'assistant', {
        type: 'message_delta',
        sessionId: s.id,
        role: 'assistant',
        text: m.text(g.size(200, 0.7, 20, 1_500)),
      })
    const tool = g.weighted(TOOL_MIX.filter(([t]) => t !== 'TodoWrite'))
    const call = makeCall(g, m, tool, s.cwd)
    const callId = `${parentCallId}-sub-${i}`
    put('tool_call', 'system', {
      type: 'tool_call',
      sessionId: s.id,
      callId,
      summary: toolSummary(tool, call.input),
      input: call.input,
    })
    put('tool_result', 'system', {
      type: 'tool_result',
      sessionId: s.id,
      callId,
      ok: call.ok,
      summary: call.output.slice(0, 300),
      output: call.output,
    })
  }
  return steps
}
