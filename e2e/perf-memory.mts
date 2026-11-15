/**
 * What the window costs in memory against a heavy store (#364 "Performance").
 *
 *   pnpm perf:memory [--profile small|owner|stress] [--engines webkit,chromium] [--stream-minutes 5]
 *                    [--ui-root <checkout>] [--label <name>] [--out <file.json>] [--quick]
 *                    [--steps blank,shell,long,scrolled,grid,switched,stream,background,revisit,appview]
 *                    [--background-minutes 30] [--background-sessions 8] [--heap-snapshots <dir>]
 *                    [--revisit-rounds 5] [--revisit-streaming 4] [--appview-idle] [--dpr 2]
 *                    [--stream-parts working,text,reasoning,tools,subagent,images,background] [--turn-steps 12]
 *                    [--reduced-motion] [--freeze-animations] [--css <file>] [--layers] [--blur]
 *
 * `--ui-root` builds the UI of another checkout (one with its own node_modules, or links to these) against the same
 * host: how a build before a change is measured. `--stream-parts` leaves parts of the stream out, `--dpr` changes
 * the device scale, `--turn-steps` the length of a turn (12 steps are about 50 s; the elapsed counter changes pace after
 * the first minute), and the next two stop the app's motion, to tell what each costs. `--css` adds a stylesheet to
 * the page once it is up, to tell what one property costs by taking it away. `--layers` lists the composited
 * layers in the grid (WebKit's with the memory it reports for each), with element, grid panel and why it is
 * composited. `--blur` takes focus out of the composer the grid focuses before the grid is sampled: a blinking caret
 * repaints, and while anything repaints WebKit keeps every layer's backing store.
 *
 * For each engine it seeds a fresh store (`e2e/fixtures/heavy-store.ts`) in a temporary data folder, starts a real
 * host on it (`CC_DATA_DIR`, `HOME` and `--db` all in that folder), builds the web UI for production against that
 * host, and drives it in Playwright's headless browser through:
 *
 *   blank       an empty page of the same origin, the engine's own floor
 *   shell       the app up, nothing opened (not in the default steps)
 *   long        the app with the longest session open
 *   scrolled    the same session after scrolling back through 20 history pages (2,000 rows)
 *   grid        the saved grid, one panel per seeded grid session
 *   switched    focus moved through 10 sessions, one after another
 *   stream-*    synthetic streaming into the long session (a turn loop: deltas, tool calls, output, a subagent, a
 *               background task, images), sampled along the way, then after it settles
 *   background-* the long session open while `--background-sessions` others stream the same turn loop out of view, as
 *               workers and linked children do, for `--background-minutes`: a few of them visited now and then, mail
 *               arriving every minute; sampled every five minutes, then after it settles (not in the default steps)
 *   revisit-*   the long session open while every other session is opened in turn, one every 30 s, scrolled back a
 *               history page every other time, and left for the long one again, for `--revisit-rounds` rounds;
 *               `--revisit-streaming` of them stream out of view meanwhile. Sampled after each round, then after it
 *               settles (not in the default steps). With 23 others the page read back alternates between rounds, so
 *               by the end of round 2 every session has been opened and read back once: memory that rises only up to
 *               then is a cost per session, memory that keeps rising after it is held per open, or by the streaming
 *               sessions (`--revisit-streaming 0` takes them out). A first open of a streaming session may read its
 *               newest page instead of an older one. Run it without background, whose streams use the same event
 *               numbers.
 *   appview-*   the same with an app's view open all along: an app shaped like the project board
 *               (e2e/fixtures/board-app.ts) in the first project, its view drawing the whole board again whenever the
 *               window is told the app changed, which here is on every tool result the streams send, and polling its
 *               queue every 15 s (not in the default steps). `--appview-idle` opens no sessions meanwhile
 *
 * Each step samples the browser's processes (footprint from `top`, the number Activity Monitor shows, and RSS
 * from `ps`), the page's DOM, its rendered conversation rows and running animations, and in Chromium the JS heap
 * over CDP. After a forced collection it reads the content footprint again (and in Chromium the heaps). WebKit is
 * measured on macOS only (both engines are the default there, Chromium elsewhere). On Windows the footprint is each
 * process's private bytes and RSS its working set, read from `Win32_Process`.
 *
 * What a number holds differs by engine where a frame is involved. `content` is the largest content process, the
 * window's own; `all content` sums every content process. WebKit runs an app's view in the window's WebContent, so its
 * `content` holds the view. Chromium gives the view's sandboxed frame a renderer of its own: its `content` and `JS heap`
 * are the window without the view, `all content` counts the view's renderer (and any spare renderer Chromium keeps), and
 * `view heap` is the heap of the view's renderers, read and collected through a session on each. Compare WebKit's
 * `content` with Chromium's `all content`. `--heap-snapshots` (Chromium) takes a heap snapshot at the first and
 * the last background sample (revisit: the first, after the first round and the last), writes them to that folder and
 * prints what grew between them by constructor.
 *
 * The streaming is not a model: the page's socket to the host is routed through Playwright (`routeWebSocket`) and
 * the events are injected there, in the host's own envelope, with the host's later event numbers shifted past
 * them. The window cannot tell them from a host's. Nothing reaches a model, and the host's store is not written.
 *
 * Only processes this script started are measured, and none are signalled but its own host. WebKit's helper
 * processes are XPC services with no parent link, so they are told apart as the WebKit processes that were not
 * there before the launch — so it must not overlap another run: `pnpm perf:memory` holds the e2e lock
 * (tooling/with-e2e-lock.ts, tooling/e2e-lock.ts) and waits for any other `pnpm e2e`, `ux` or `perf` first.
 *
 * Results: docs/spikes/2026-10-memory-heavy-store.md.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  chromium,
  webkit,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type WebSocketRoute,
} from '@playwright/test'
import { errorMessage } from '@cc/protocol'
import { seedBoardApp } from './fixtures/board-app.js'
import { screenshotPng, seedHeavyStore, type SeedSummary, type StoreProfile } from './fixtures/heavy-store.js'
import { freePort } from './fixtures/real-host.js'

const root = fileURLToPath(new URL('../', import.meta.url))

/** What the synthetic stream is made of; leaving parts out tells which of them the memory goes to */
const STREAM_PARTS = ['working', 'text', 'reasoning', 'tools', 'subagent', 'images', 'background'] as const
type StreamPart = (typeof STREAM_PARTS)[number]
const STEPS = ['blank', 'shell', 'long', 'scrolled', 'grid', 'switched', 'stream', 'background', 'revisit', 'appview'] as const
type Step = (typeof STEPS)[number]

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'owner' },
    engines: { type: 'string' },
    'stream-minutes': { type: 'string', default: '5' },
    'ui-root': { type: 'string', default: root },
    label: { type: 'string', default: 'main' },
    out: { type: 'string' },
    quick: { type: 'boolean', default: false },
    steps: { type: 'string', default: 'blank,long,scrolled,grid,switched,stream' },
    'stream-parts': { type: 'string', default: STREAM_PARTS.join(',') },
    'turn-steps': { type: 'string', default: '12' },
    dpr: { type: 'string', default: '2' },
    'reduced-motion': { type: 'boolean', default: false },
    'freeze-animations': { type: 'boolean', default: false },
    layers: { type: 'boolean', default: false },
    blur: { type: 'boolean', default: false },
    css: { type: 'string' },
    'background-minutes': { type: 'string', default: '30' },
    'background-sessions': { type: 'string', default: '8' },
    'heap-snapshots': { type: 'string' },
    'revisit-rounds': { type: 'string', default: '5' },
    'revisit-streaming': { type: 'string', default: '4' },
    'appview-idle': { type: 'boolean', default: false },
  },
})
const profile = values.profile as StoreProfile
// WebKit's processes are told apart by their macOS names (roleOf); anywhere else every footprint would read 0
const engines = (values.engines ?? (process.platform === 'darwin' ? 'webkit,chromium' : 'chromium')).split(',') as Engine[]
if (engines.includes('webkit') && process.platform !== 'darwin')
  throw new Error('WebKit is measured on macOS only: its processes are found by their macOS names. Use --engines chromium.')
const streamMs = Number(values['stream-minutes']) * 60_000
const backgroundMs = Number(values['background-minutes']) * 60_000
const BACKGROUND_SESSIONS = Number(values['background-sessions'])
const REVISIT_ROUNDS = Number(values['revisit-rounds'])
const REVISIT_STREAMING = Number(values['revisit-streaming'])
const quick = values.quick
/** How often the revisit step opens the next session: in the owner profile each of the 23 others comes round every ~12 min */
const REVISIT_EVERY_MS = quick ? 5_000 : 30_000
const steps = new Set(values.steps.split(',') as Step[])
const parts = new Set(values['stream-parts'].split(',') as StreamPart[])
for (const x of steps) if (!STEPS.includes(x)) throw new Error(`unknown step ${x}`)
for (const x of parts) if (!STREAM_PARTS.includes(x)) throw new Error(`unknown stream part ${x}`)
const DPR = Number(values.dpr)
/** Steps per turn: reasoning, text and a tool call each, ~4.3 s at the stream's pace */
const TURN_STEPS = Number(values['turn-steps'])
/** How long a step is left alone before it is sampled */
const SETTLE_MS = quick ? 2_000 : 10_000
const VIEWPORT = { width: 1440, height: 900 }

type Engine = 'webkit' | 'chromium'
type Proc = { pid: number; role: string; footprintMB: number; rssMB: number }
type Sample = {
  step: string
  atSec: number
  /** Footprint by role: content (WebContent / renderers), ui (UI or browser process), gpu, network, other */
  footprintMB: Record<string, number>
  rssMB: Record<string, number>
  totalFootprintMB: number
  /**
   * The largest content process: the window's own. A Chromium renderer of a frame's own (an app's view) is not in it;
   * `footprintMB.content` sums every content process
   */
  contentFootprintMB: number
  hostFootprintMB: number
  processes: number
  /** The window page's JS heap (Chromium) */
  heapUsedMB: number | null
  heapTotalMB: number | null
  /** The JS heap of the app view's frames that run in renderers of their own (Chromium, appview); null without any */
  viewHeapUsedMB: number | null
  domNodes: number
  elements: number
  jsEventListeners: number | null
  renderedRows: number
  chatStreams: number
  images: number
  /** Running animations (CSS and Web Animations): each keeps the compositor producing frames */
  animations: number
  animationNames: string
  /** How many of the script's own animation-off style elements the page has (0 unless --freeze-animations) */
  frozen: number
  /** Conversation rows the page received over its socket so far (history pages and injected events) */
  rowsReceived: number
  wsBytesIn: number
  /** The same after a forced collection (the heaps: Chromium only), which tells what is held from what is merely not yet collected */
  afterGc: {
    contentFootprintMB: number
    /** Every content process together, as `footprintMB.content` */
    allContentFootprintMB: number
    heapUsedMB: number | null
    viewHeapUsedMB: number | null
  } | null
  /**
   * The last injected text is in the page: stream steps only, where it goes to the open session. Elsewhere it goes to
   * sessions out of view, so the answer would be false whatever the window drew: null there
   */
  painted: boolean | null
}

// ── Processes ──────────────────────────────────────────────────────────────────────────────

type ProcRow = { pid: number; ppid: number; rssKB: number; command: string; privateMB?: number }

function psTable(): ProcRow[] {
  if (process.platform === 'win32') return winTable()
  return execFileSync('ps', ['-Ao', 'pid=,ppid=,rss=,command='], { maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), command: m[4]! }))
}

/** Windows has no `ps`: the same table from `Win32_Process`, with each process's private bytes as its footprint */
function winTable(): ProcRow[] {
  const query =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,CommandLine | ConvertTo-Json -Compress'
  const rows = JSON.parse(
    execFileSync('powershell.exe', ['-NoProfile', '-Command', query], { maxBuffer: 64 * 1024 * 1024 }).toString(),
  ) as { ProcessId: number; ParentProcessId: number; WorkingSetSize: number; PrivatePageCount: number; CommandLine: string | null }[]
  return rows.map((r) => ({
    pid: r.ProcessId,
    ppid: r.ParentProcessId,
    rssKB: r.WorkingSetSize / 1024,
    command: r.CommandLine ?? '',
    privateMB: r.PrivatePageCount / 1048576,
  }))
}

/** `top`'s MEM column is the physical footprint — what Activity Monitor calls Memory. Reading it asks for nothing */
function footprints(table: ProcRow[]): Map<number, number> {
  if (process.platform === 'win32') return new Map(table.map((p) => [p.pid, p.privateMB ?? 0]))
  const out = execFileSync('top', ['-l', '1', '-stats', 'pid,mem'], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString()
  const map = new Map<number, number>()
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)([BKMG])[+-]?\s*$/)
    if (!m) continue
    const unit = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 }[m[3] as 'B' | 'K' | 'M' | 'G']
    map.set(Number(m[1]), Number(m[2]) * unit)
  }
  return map
}

function descendants(table: ReturnType<typeof psTable>, of: number): Set<number> {
  const mine = new Set([of])
  for (let grew = true; grew;) {
    grew = false
    for (const p of table) {
      if (!mine.has(p.pid) && mine.has(p.ppid)) {
        mine.add(p.pid)
        grew = true
      }
    }
  }
  mine.delete(of)
  return mine
}

function roleOf(engine: Engine, command: string): string | null {
  if (engine === 'webkit') {
    if (command.includes('WebKit.WebContent')) return 'content'
    if (command.includes('WebKit.GPU')) return 'gpu'
    if (command.includes('WebKit.Networking')) return 'network'
    if (command.includes('Playwright.app/Contents/MacOS/Playwright')) return 'ui'
    return null
  }
  if (!/chrome for testing|chromium/i.test(command)) return null
  if (command.includes('--type=renderer')) return 'content'
  if (command.includes('--type=gpu-process')) return 'gpu'
  if (command.includes('--type=utility')) return command.includes('network') ? 'network' : 'other'
  if (command.includes('--type=')) return 'other'
  return 'ui'
}

/** WebKit's helpers belong to launchd, not to the browser: they are the WebKit processes that are new since launch */
function engineProcs(engine: Engine, before: Set<number>, hostPid: number): { procs: Proc[]; host: number } {
  const table = psTable()
  const fp = footprints(table)
  const mine = descendants(table, process.pid)
  const procs: Proc[] = []
  for (const p of table) {
    if (p.pid === hostPid) continue
    const role = roleOf(engine, p.command)
    if (!role) continue
    const ours =
      engine === 'webkit' ? p.command.includes('ms-playwright/webkit') && !before.has(p.pid) : mine.has(p.pid)
    if (!ours) continue
    procs.push({ pid: p.pid, role, footprintMB: fp.get(p.pid) ?? 0, rssMB: p.rssKB / 1024 })
  }
  return { procs, host: fp.get(hostPid) ?? 0 }
}

// ── The page's side ────────────────────────────────────────────────────────────────────────

async function pageCounts(page: Page) {
  return page.evaluate(() => {
    let nodes = 0
    const walk = document.createTreeWalker(document, NodeFilter.SHOW_ALL)
    while (walk.nextNode()) nodes++
    return {
      domNodes: nodes,
      elements: document.getElementsByTagName('*').length,
      renderedRows: document.querySelectorAll('[data-testid="chat-stream"] [data-index]').length,
      chatStreams: document.querySelectorAll('[data-testid="chat-stream"]').length,
      images: document.images.length,
      animations: document.getAnimations().length,
      frozen: document.querySelectorAll('style[data-perf-freeze]').length,
      animationNames: [
        ...new Set(
          document.getAnimations().map((x) => ('animationName' in x ? String(x.animationName) : 'script')),
        ),
      ].join(','),
    }
  })
}

/** Describes the element an inspector object stands for, and the grid panel it is in */
const DESCRIBE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement
  if (!el) return { panel: '', node: this.nodeName }
  const p = el.closest('[data-testid^="grid-panel-"]')
  const id = el.getAttribute('data-testid')
  const cls = (el.getAttribute('class') || '').slice(0, 70)
  return { panel: p ? p.getAttribute('data-testid') : '', node: el.tagName.toLowerCase() + (id ? '#' + id : '') + (cls ? ' .' + cls : '') }
}`

type Layer = {
  /** The grid panel the layer's element is in (`grid-panel-<id>`), or '' outside every panel */
  panel: string
  /** The element: tag, test id, the start of its class list */
  node: string
  width: number
  height: number
  /** WebKit: the layer's backing store as WebKit reports it. Chromium: its area at the page's device scale, 4 bytes a pixel */
  mb: number
  drawsContent: boolean
  reasons: string[]
}

/**
 * Chromium's composited layers, with why each one is composited and which element and grid panel it belongs to
 * (CDP `LayerTree`). Chromium reports no memory per layer; `mb` is the layer's whole area, which tiling may not fill.
 */
async function compositedLayers(cdp: CDPSession, page: Page): Promise<Layer[]> {
  type Raw = {
    layerId: string
    backendNodeId?: number
    width: number
    height: number
    drawsContent: boolean
    invisible?: boolean
  }
  const tree = new Promise<Raw[]>((ok) =>
    cdp.once('LayerTree.layerTreeDidChange', (e: { layers?: Raw[] }) => ok(e.layers ?? [])),
  )
  await cdp.send('DOM.getDocument', { depth: 0 })
  await cdp.send('LayerTree.enable')
  // A frame has to be produced for the tree to be reported; nudge one without changing anything
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  )
  const raw = await tree
  const out: Layer[] = []
  for (const l of raw) {
    if (l.invisible) continue
    const { compositingReasons = [] } = (await cdp
      .send('LayerTree.compositingReasons', { layerId: l.layerId })
      .catch(() => ({}))) as { compositingReasons?: string[] }
    let panel = ''
    let node = '(no element)'
    if (l.backendNodeId) {
      const resolved = (await cdp
        .send('DOM.resolveNode', { backendNodeId: l.backendNodeId })
        .catch(() => null)) as { object?: { objectId?: string } } | null
      const objectId = resolved?.object?.objectId
      if (objectId) {
        const r = (await cdp.send('Runtime.callFunctionOn', {
          objectId,
          returnByValue: true,
          functionDeclaration: DESCRIBE,
        })) as { result: { value?: { panel: string; node: string } } }
        panel = r.result.value?.panel ?? ''
        node = r.result.value?.node ?? node
      }
    }
    out.push({
      panel,
      node,
      width: Math.round(l.width),
      height: Math.round(l.height),
      mb: l.drawsContent ? round((l.width * l.height * DPR * DPR * 4) / 1048576) : 0,
      drawsContent: l.drawsContent,
      reasons: compositingReasons,
    })
  }
  await cdp.send('LayerTree.disable')
  return out
}

/**
 * WebKit's composited layers with the memory WebKit itself reports for each (Web Inspector's `LayerTree` domain, the
 * Layers tab). Playwright has no public door to it; this reaches the page's inspector session through Playwright's
 * in-process internals (`_connection.toImpl`), which a Playwright upgrade may move. Measuring only.
 */
async function webkitLayers(page: Page): Promise<Layer[]> {
  type Session = { send: (method: string, params?: object) => Promise<any> }
  type Raw = {
    layerId: string
    nodeId?: number
    compositedBounds: { width: number; height: number }
    memory: number
    pseudoElement?: string
  }
  const s = (page as unknown as { _connection: { toImpl: (x: unknown) => { delegate: { _session: Session } } } })
    ._connection.toImpl(page).delegate._session
  const { root } = (await s.send('DOM.getDocument')) as { root: { nodeId: number } }
  await s.send('LayerTree.enable')
  const { layers } = (await s.send('LayerTree.layersForNode', { nodeId: root.nodeId })) as { layers: Raw[] }
  const out: Layer[] = []
  for (const l of layers) {
    const { compositingReasons = {} } = (await s
      .send('LayerTree.reasonsForCompositingLayer', { layerId: l.layerId })
      .catch(() => ({}))) as { compositingReasons?: Record<string, boolean> }
    let panel = ''
    let node = '(no element)'
    if (l.nodeId) {
      const resolved = (await s.send('DOM.resolveNode', { nodeId: l.nodeId }).catch(() => null)) as {
        object?: { objectId?: string }
      } | null
      if (resolved?.object?.objectId) {
        const r = (await s.send('Runtime.callFunctionOn', {
          objectId: resolved.object.objectId,
          returnByValue: true,
          functionDeclaration: DESCRIBE,
        })) as { result: { value?: { panel: string; node: string } } }
        panel = r.result.value?.panel ?? ''
        node = r.result.value?.node ?? node
      }
    }
    out.push({
      panel,
      node: node + (l.pseudoElement ? `::${l.pseudoElement}` : ''),
      width: Math.round(l.compositedBounds.width),
      height: Math.round(l.compositedBounds.height),
      mb: round(l.memory / 1048576),
      drawsContent: l.memory > 0,
      reasons: Object.keys(compositingReasons).filter((k) => compositingReasons[k]),
    })
  }
  await s.send('LayerTree.disable')
  return out
}

async function heap(cdp: CDPSession | null) {
  if (!cdp) return { heapUsedMB: null, heapTotalMB: null, jsEventListeners: null }
  const h = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; totalSize: number }
  const d = (await cdp.send('Memory.getDOMCounters')) as { jsEventListeners: number }
  return {
    heapUsedMB: h.usedSize / 1048576,
    heapTotalMB: h.totalSize / 1048576,
    jsEventListeners: d.jsEventListeners,
  }
}

/** The JS heap used in these sessions' renderers together; null without any, or once one of them is gone */
async function heapOf(sessions: CDPSession[]): Promise<number | null> {
  if (!sessions.length) return null
  let used = 0
  for (const s of sessions) {
    const h = (await s.send('Runtime.getHeapUsage').catch(() => null)) as { usedSize: number } | null
    if (!h) return null
    used += h.usedSize
  }
  return used / 1048576
}

type HeapClasses = Map<string, { bytes: number; count: number }>

/**
 * What the JS heap holds by constructor, after a forced collection: self bytes and count per object constructor, the rest
 * by node type (`(string)`, `(code)`…). The snapshot is written to `file` for a closer look in DevTools.
 */
async function heapClasses(cdp: CDPSession, file: string): Promise<HeapClasses> {
  const chunks: string[] = []
  const onChunk = (e: { chunk: string }) => chunks.push(e.chunk)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  const text = chunks.join('')
  writeFileSync(file, text)
  const snap = JSON.parse(text) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } }
    nodes: number[]
    strings: string[]
  }
  const fields = snap.snapshot.meta.node_fields
  const types = snap.snapshot.meta.node_types[0]
  const [type, name, self] = ['type', 'name', 'self_size'].map((k) => fields.indexOf(k)) as [number, number, number]
  const out: HeapClasses = new Map()
  for (let i = 0; i < snap.nodes.length; i += fields.length) {
    const t = types[snap.nodes[i + type]!]!
    const key = t === 'object' ? snap.strings[snap.nodes[i + name]!]!.replace(/ @\d+$/, '') : `(${t})`
    const cur = out.get(key) ?? { bytes: 0, count: 0 }
    cur.bytes += snap.nodes[i + self]!
    cur.count++
    out.set(key, cur)
  }
  return out
}

/** The constructors that grew most between two snapshots: only those whose bytes grew, so fewer than `top` rows when fewer grew */
function heapGrowth(from: HeapClasses, to: HeapClasses, top = 25): { name: string; mb: number; count: number }[] {
  return [...to]
    .map(([name, v]) => ({ name, bytes: v.bytes - (from.get(name)?.bytes ?? 0), count: v.count - (from.get(name)?.count ?? 0) }))
    .filter((g) => g.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, top)
    .map(({ name, bytes, count }) => ({ name, mb: round(bytes / 1048576), count }))
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
const round = (n: number) => Math.round(n * 10) / 10
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── The socket between page and host ──────────────────────────────────────────────────────

/**
 * Forwards every frame, counting what the page receives, and lets the script inject events. An injected event takes
 * the next event number; every later host event is shifted past it, so the page's duplicate filter (#82) sees one
 * rising sequence.
 */
class Wire {
  private page: WebSocketRoute | null = null
  private offset = 0
  private lastSeq = 0
  private pending = new Map<string, string>()
  bytesIn = 0
  /** The last assistant text injected, to check the page drew it */
  lastText = ''
  rowsReceived = 0
  historyPages = 0

  async attach(context: BrowserContext, hostPort: number): Promise<void> {
    await context.routeWebSocket(
      (url) => url.port === String(hostPort),
      (ws) => {
        const server = ws.connectToServer()
        this.page = ws
        ws.onMessage((raw) => {
          if (typeof raw === 'string') {
            const f = JSON.parse(raw) as { kind: string; id?: string; method?: string; afterSeq?: number }
            if (f.kind === 'rpc' && f.id && f.method) this.pending.set(f.id, f.method)
            if (f.kind === 'hello' && typeof f.afterSeq === 'number') {
              f.afterSeq = Math.max(0, f.afterSeq - this.offset)
              raw = JSON.stringify(f)
            }
          }
          server.send(raw)
        })
        server.onMessage((raw) => {
          if (typeof raw !== 'string') return ws.send(raw)
          this.bytesIn += raw.length
          const f = JSON.parse(raw) as {
            kind: string
            id?: string
            seq?: number
            currentSeq?: number
            result?: unknown
            ok?: boolean
          }
          if (f.kind === 'event' && typeof f.seq === 'number') {
            f.seq += this.offset
            this.lastSeq = Math.max(this.lastSeq, f.seq)
            return ws.send(JSON.stringify(f))
          }
          if (f.kind === 'hello_ok' && typeof f.currentSeq === 'number') {
            f.currentSeq += this.offset
            this.lastSeq = Math.max(this.lastSeq, f.currentSeq)
            return ws.send(JSON.stringify(f))
          }
          if (f.kind === 'res' && f.id) {
            const method = this.pending.get(f.id)
            this.pending.delete(f.id)
            if (method === 'messages.load' && f.ok && Array.isArray(f.result)) {
              this.rowsReceived += f.result.length
              this.historyPages++
            }
          }
          ws.send(raw)
        })
      },
    )
  }

  inject(event: Record<string, unknown>): void {
    if (!this.page) throw new Error('the page has no socket yet')
    this.offset++
    this.lastSeq++
    const raw = JSON.stringify({ kind: 'event', seq: this.lastSeq, event })
    this.bytesIn += raw.length
    if (['tool_call', 'tool_result', 'message_image', 'user_message'].includes(String(event.type)))
      this.rowsReceived++
    if (event.type === 'user_message') this.lastText = String(event.text)
    this.page.send(raw)
  }
}

// ── Synthetic streaming ────────────────────────────────────────────────────────────────────

/**
 * A deterministic turn loop at a model's pace: ~70 tokens a second, a tool call every few seconds. `sample` is called
 * at 60 s, 150 s and the end; `onToolResult` after each tool result is sent.
 */
async function stream(
  wire: Wire,
  sessionId: string,
  firstSeq: number,
  ms: number,
  { sample, onToolResult }: { sample?: (step: string) => Promise<void>; onToolResult?: () => void } = {},
): Promise<void> {
  let seq = firstSeq
  let n = 0
  const r = (() => {
    let a = 7
    return () => (a = (a * 1103515245 + 12345) >>> 0) / 4294967296
  })()
  const words =
    'the window keeps every row it has drawn and the host keeps the rest of the conversation in its store'.split(
      ' ',
    )
  const say = (count: number) =>
    Array.from({ length: count }, () => words[Math.floor(r() * words.length)]).join(' ') + ' '
  // A live screenshot carries its bytes, as the host broadcasts it
  const png = screenshotPng(3, 1440, 900).toString('base64')
  const start = Date.now()
  const marks = sample ? [60_000, 150_000, ms].filter((t) => t <= ms) : []
  const send = (part: StreamPart, e: Record<string, unknown>) => {
    if (parts.has(part)) wire.inject({ sessionId, ...e })
  }
  let turn = 0
  while (Date.now() - start < ms) {
    turn++
    send('text', { type: 'user_message', seq: ++seq, text: `Turn ${turn}: ${say(30)}` })
    send('working', { type: 'state_change', state: 'working' })
    send('background', {
      type: 'background_tasks',
      live: [
        {
          id: `bg-${turn}`,
          kind: 'shell',
          description: 'pnpm exec vite --port 5174',
          status: 'running',
          stoppable: true,
        },
      ],
    })
    for (let step = 0; step < TURN_STEPS && Date.now() - start < ms; step++) {
      // Reasoning, then text, streamed in small pieces
      const thinkSeq = ++seq
      for (let i = 0; i < 10; i++) {
        send('reasoning', { type: 'reasoning_delta', seq: thinkSeq, text: say(4) })
        await sleep(50)
      }
      const textSeq = ++seq
      const messageId = `msg-${turn}-${step}`
      for (let i = 0; i < 40; i++) {
        send('text', { type: 'message_delta', seq: textSeq, role: 'assistant', messageId, text: say(3) })
        await sleep(45)
      }
      // A tool call with live output and its result
      const callId = `inj-${turn}-${step}`
      const subagent = step === 6
      const card: StreamPart = subagent ? 'subagent' : 'tools'
      send(card, {
        type: 'tool_call',
        seq: ++seq,
        callId,
        summary: subagent
          ? {
              tool: 'Agent',
              title: 'Look for the memory that is never given back',
              paths: [],
            }
          : { tool: 'Bash', title: 'pnpm exec vitest run --maxWorkers=4', paths: [] },
      })
      for (let i = 0; i < 20; i++) {
        if (subagent) {
          send('subagent', {
            type: 'subagent_event',
            parentCallId: callId,
            // The window keeps steps only under a card whose steps are open; none is here, as when nobody looks
            stepSeq: i * 2 + 1,
            step: {
              type: 'tool_call',
              sessionId,
              callId: `${callId}-s${i}`,
              summary: {
                tool: 'Read',
                title: `Read: packages/ui/src/store/file-${i}.ts`,
                paths: [],
              },
            },
          })
          send('subagent', {
            type: 'subagent_event',
            parentCallId: callId,
            stepSeq: i * 2 + 2,
            step: { type: 'tool_result', sessionId, callId: `${callId}-s${i}`, ok: true, summary: say(40) },
          })
        } else
          send('tools', {
            type: 'tool_output_delta',
            callId,
            text: ` ✓ packages/ui/src/store/store.test.ts (${i + 1} tests) ${say(8)}\n`,
          })
        await sleep(100)
      }
      send(card, { type: 'tool_result', seq: ++seq, callId, ok: true, summary: say(50).slice(0, 300) })
      onToolResult?.()
      if (step === 9 && turn % 2 === 1)
        send('images', { type: 'message_image', mime: 'image/png', data: png })
      send('working', {
        type: 'usage_update',
        tokens: {
          inputTokens: 1200,
          outputTokens: 400 + n,
          cacheReadTokens: 90_000,
          cacheCreationTokens: 2_000,
        },
      })
      n++
      while (marks.length && Date.now() - start >= marks[0]!) {
        const t = marks.shift()!
        if (t < ms) await sample!(`stream-${Math.round(t / 1000)}s`)
      }
    }
    send('background', {
      type: 'background_tasks',
      live: [],
      ended: [
        { id: `bg-${turn}`, kind: 'shell', description: 'pnpm exec vite --port 5174', status: 'completed' },
      ],
    })
    send('working', { type: 'turn_complete' })
    send('working', { type: 'state_change', state: 'idle' })
  }
}

// ── Host, UI build and static server ──────────────────────────────────────────────────────

async function startHost(
  dataDir: string,
  home: string,
  port: number,
  token: string,
  origin: string,
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'packages/agent-host/src/main.ts',
      '--port',
      String(port),
      '--db',
      join(dataDir, 'store.db'),
      '--token',
      token,
    ],
    {
      cwd: root,
      env: { ...process.env, CC_DATA_DIR: dataDir, HOME: home, CC_HOST_ALLOWED_ORIGINS: origin, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + String(d)).slice(-20_000)))
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`host did not become ready\n${stderr}`)), 120_000)
    child.once('exit', (code) => fail(new Error(`host exited (${code})\n${stderr}`)))
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        if ((JSON.parse(line) as { ready?: boolean }).ready) {
          clearTimeout(timer)
          ok()
        }
      } catch {
        // Not the ready line
      }
    })
  })
  return child
}

function buildUi(uiRoot: string, outDir: string, token: string, hostPort: number): void {
  // Vite's own script under node rather than `pnpm exec`: Windows starts no `.cmd` without a shell
  const r = spawnSync(
    process.execPath,
    [
      join(uiRoot, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      join(uiRoot, 'apps/web/vite.config.ts'),
      '--outDir',
      outDir,
      '--emptyOutDir',
      '--logLevel',
      'warn',
    ],
    {
      cwd: uiRoot,
      env: { ...process.env, VITE_HOST_TOKEN: token, VITE_HOST_URL: `ws://127.0.0.1:${hostPort}` },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  )
  if (r.status !== 0) throw new Error('vite build failed')
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

function serve(dir: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    if (path === '/blank.html') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<!doctype html><title>blank</title>')
    }
    let file = resolve(dir, '.' + path)
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory())
      file = join(dir, 'index.html')
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)))
}

// ── One engine, start to end ───────────────────────────────────────────────────────────────

async function measureEngine(
  engine: Engine,
): Promise<{
  engine: Engine
  seed: Omit<SeedSummary, 'sessions' | 'projects'>
  samples: Sample[]
  layers: Layer[] | null
  heapGrowth: { span: string; rows: ReturnType<typeof heapGrowth> }[]
}> {
  const work = mkdtempSync(join(tmpdir(), 'centralu-perf-memory-'))
  const dataDir = join(work, 'data')
  const home = join(work, 'home')
  mkdirSync(home)
  const samples: Sample[] = []
  let layers: Layer[] | null = null
  let host: ChildProcess | null = null
  let server: Server | null = null
  let browser: Browser | null = null
  try {
    console.error(`[${engine}] seeding ${profile}`)
    const seed = seedHeavyStore(dataDir, profile)
    const boardApp = steps.has('appview') ? seedBoardApp(dataDir, seed.projects[0]!) : null
    const token = randomBytes(16).toString('hex')
    const [hostPort, uiPort] = [await freePort(), await freePort()]
    const origin = `http://127.0.0.1:${uiPort}`
    console.error(`[${engine}] building the UI from ${values['ui-root']}`)
    buildUi(resolve(values['ui-root']), join(work, 'ui'), token, hostPort)
    server = await serve(join(work, 'ui'), uiPort)
    host = await startHost(dataDir, home, hostPort, token, origin)

    const before = new Set(psTable().map((p) => p.pid))
    browser = await (engine === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chromium' }))
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DPR,
      baseURL: origin,
      // The app's spinning markers stop under reduced motion (styles/index.css), which isolates what they cost
      reducedMotion: values['reduced-motion'] ? 'reduce' : 'no-preference',
    })
    // Playwright holds a handle on every console argument in the page and does not release the ones it trims from its
    // list (1.62), so a page that logs objects (ext-apps' message transport logs every app message) would grow here
    // without end, and not in the app. Releasing them leaves the engine's own bounded console store.
    context.on('console', (m) => {
      for (const arg of m.args()) void arg.dispose().catch(() => {})
    })
    const wire = new Wire()
    await wire.attach(context, hostPort)
    const page = await context.newPage()
    const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null
    const t0 = Date.now()
    const snapshots = values['heap-snapshots'] && cdp ? resolve(values['heap-snapshots']) : null
    if (snapshots) mkdirSync(snapshots, { recursive: true })
    /** Sessions on the app view's frames that run in renderers of their own (Chromium, appview), which `cdp` does not reach */
    const viewCdp: CDPSession[] = []
    /** The JS heaps by constructor now, the window's and each of `viewCdp`'s, written into the --heap-snapshots folder; null without one */
    const snapshot = async (step: string): Promise<Map<string, HeapClasses> | null> => {
      if (!snapshots) return null
      const heaps = [
        { heapName: 'window', session: cdp!, name: step },
        ...viewCdp.map((session, i) => ({ heapName: `view ${i + 1}`, session, name: `${step}-view-${i + 1}` })),
      ]
      const out = new Map<string, HeapClasses>()
      for (const { heapName, session, name } of heaps)
        out.set(heapName, await heapClasses(session, join(snapshots, `${engine}-${name}.heapsnapshot`)))
      return out
    }
    const grown: { span: string; rows: ReturnType<typeof heapGrowth> }[] = []
    /** What each heap gained between two snapshots */
    const grow = (span: string, from: Map<string, HeapClasses> | null, to: Map<string, HeapClasses> | null) => {
      for (const [heapName, classes] of from ?? []) {
        const end = to?.get(heapName)
        if (end) grown.push({ span: `${span}, ${heapName}`, rows: heapGrowth(classes, end) })
      }
    }

    const sample = async (step: string) => {
      const reps: Sample[] = []
      for (let i = 0; i < 3; i++) {
        if (i) await sleep(1_000)
        const { procs, host: hostFp } = engineProcs(engine, before, host!.pid!)
        const footprintMB: Record<string, number> = {}
        const rssMB: Record<string, number> = {}
        for (const p of procs) {
          footprintMB[p.role] = (footprintMB[p.role] ?? 0) + p.footprintMB
          rssMB[p.role] = (rssMB[p.role] ?? 0) + p.rssMB
        }
        reps.push({
          step,
          atSec: Math.round((Date.now() - t0) / 1000),
          footprintMB,
          rssMB,
          totalFootprintMB: procs.reduce((s, p) => s + p.footprintMB, 0),
          contentFootprintMB: Math.max(
            0,
            ...procs.filter((p) => p.role === 'content').map((p) => p.footprintMB),
          ),
          hostFootprintMB: hostFp,
          processes: procs.length,
          ...(await heap(cdp)),
          viewHeapUsedMB: await heapOf(viewCdp),
          ...(await pageCounts(page)),
          jsEventListeners: null,
          rowsReceived: wire.rowsReceived,
          wsBytesIn: wire.bytesIn,
          afterGc: null,
          painted: step.startsWith('stream-') && wire.lastText
            ? await page.evaluate((t) => document.body.innerText.includes(t.trim()), wire.lastText)
            : null,
        })
      }
      // The median repetition by total footprint, whole, so its numbers belong together
      const pick = reps.find((s) => s.totalFootprintMB === median(reps.map((x) => x.totalFootprintMB)))!
      const h = await heap(cdp)
      pick.jsEventListeners = h.jsEventListeners
      // WebKit has no CDP: Playwright's requestGC is the inspector's Heap.gc, a full collection of the page's VM. Its
      // allocator gives freed pages back to the system on a timer of its own, so the footprint is read after a wait.
      // The after-GC numbers are extra: when the collection fails they are left out (null) and the run goes on.
      let collected = true
      try {
        if (cdp) await cdp.send('HeapProfiler.collectGarbage')
        else await page.requestGC()
      } catch (e) {
        collected = false
        console.error(`[${engine}] ${step}: the forced collection failed, so there are no after-GC numbers: ${errorMessage(e)}`)
      }
      if (collected) {
        for (const s of viewCdp) await s.send('HeapProfiler.collectGarbage').catch(() => {})
        await sleep(cdp ? 1_000 : 5_000)
        const content = engineProcs(engine, before, host!.pid!).procs.filter((p) => p.role === 'content').map((p) => p.footprintMB)
        const after = await heap(cdp)
        const afterView = await heapOf(viewCdp)
        pick.afterGc = {
          contentFootprintMB: round(Math.max(0, ...content)),
          allContentFootprintMB: round(content.reduce((a, b) => a + b, 0)),
          heapUsedMB: after.heapUsedMB === null ? null : round(after.heapUsedMB),
          viewHeapUsedMB: afterView === null ? null : round(afterView),
        }
      }
      const out = {
        ...pick,
        footprintMB: Object.fromEntries(Object.entries(pick.footprintMB).map(([k, v]) => [k, round(v)])),
        rssMB: Object.fromEntries(Object.entries(pick.rssMB).map(([k, v]) => [k, round(v)])),
        totalFootprintMB: round(pick.totalFootprintMB),
        contentFootprintMB: round(pick.contentFootprintMB),
        hostFootprintMB: round(pick.hostFootprintMB),
        heapUsedMB: pick.heapUsedMB === null ? null : round(pick.heapUsedMB),
        heapTotalMB: pick.heapTotalMB === null ? null : round(pick.heapTotalMB),
        viewHeapUsedMB: pick.viewHeapUsedMB === null ? null : round(pick.viewHeapUsedMB),
      }
      samples.push(out)
      // Only what was read: WebKit has no heaps, a step without a view no view heap, a failed collection no after-GC
      const heaps = (heap: number | null, view: number | null) =>
        (heap === null ? '' : ` heap=${heap}MB`) + (view === null ? '' : ` view=${view}MB`)
      const gc = out.afterGc
      console.error(
        `[${engine}] ${step.padEnd(14)} content=${out.contentFootprintMB}MB all=${out.footprintMB.content ?? 0}MB` +
          `${heaps(out.heapUsedMB, out.viewHeapUsedMB)} total=${out.totalFootprintMB}MB | after GC: ` +
          (gc ? `content=${gc.contentFootprintMB}MB all=${gc.allContentFootprintMB}MB${heaps(gc.heapUsedMB, gc.viewHeapUsedMB)}` : 'none') +
          ` | nodes=${out.domNodes} rows=${out.renderedRows} received=${out.rowsReceived} host=${out.hostFootprintMB}MB` +
          (out.painted === null ? '' : ` painted=${out.painted}`),
      )
    }

    // blank: the engine's floor, same origin
    if (steps.has('blank')) {
      await page.goto('/blank.html')
      await sleep(SETTLE_MS)
      await sample('blank')
    }

    // shell: the app up, nothing opened yet
    await page.goto('/')
    // Every animation and transition off: what the window costs with nothing moving. Added to the page rather than
    // as an init script, which does not run in WebKit alongside the socket route
    if (values['freeze-animations']) {
      await page.addStyleTag({
        content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
      })
      await page.evaluate(() => document.head.lastElementChild?.setAttribute('data-perf-freeze', ''))
    }
    // Any other CSS, to tell what one property costs by taking it away (how the grid's layers were attributed)
    if (values.css) await page.addStyleTag({ path: resolve(values.css) })
    const row = (id: string) => page.getByTestId(`session-row-${id}`)
    /** Opens a session from its sidebar row and waits for its conversation */
    const open = async (id: string) => {
      await row(id).click()
      await page
        .locator('[data-testid="chat-stream"] [data-index]')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => {})
    }
    /** Scrolls the open conversation back until one more history page has arrived, or eight seconds pass */
    const pageBack = async () => {
      await page.getByTestId('chat-stream').hover()
      const pages = wire.historyPages
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-stream"]')
        if (el) el.scrollTop = 0
      })
      const t = Date.now()
      while (wire.historyPages === pages && Date.now() - t < 8_000) {
        await page.mouse.wheel(0, -2_000)
        await sleep(150)
      }
    }
    await row(seed.longSessionId).waitFor({ timeout: 60_000 })
    if (steps.has('shell')) {
      await sleep(SETTLE_MS)
      await sample('shell')
    }

    // long: the longest session open
    await row(seed.longSessionId).click()
    await page.locator('[data-testid="chat-stream"] [data-index]').first().waitFor({ timeout: 60_000 })
    if (steps.has('long')) {
      await sleep(SETTLE_MS)
      await sample('long')
    }

    // scrolled: 20 history pages back
    if (steps.has('scrolled')) {
      for (let i = 0; i < 20; i++) {
        await pageBack()
        await sleep(300)
      }
      await sleep(SETTLE_MS)
      await sample('scrolled')
    }

    // grid: the saved panels
    if (steps.has('grid')) {
      await page.getByTestId('grid-button').click()
      await page.getByTestId(`grid-panel-${seed.gridSessionIds.at(-1)}`).waitFor({ timeout: 60_000 })
      // The grid puts focus in the selected panel's composer; its blinking caret is a repaint (§3 of the record)
      if (values.blur) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await sleep(SETTLE_MS)
      await sample('grid')
      if (values.layers) layers = cdp ? await compositedLayers(cdp, page) : await webkitLayers(page)
    }

    // switched: ten sessions, one after another, then back to the long one
    if (steps.has('switched')) {
      const others = seed.sessions.slice(1, 11)
      for (const s of others) {
        await open(s.id)
        await sleep(quick ? 300 : 1_500)
      }
      await row(seed.longSessionId).click()
      await sleep(SETTLE_MS)
      await sample('switched')
    }

    // streaming into the long session, watched from its end as a person watches a running turn
    if (steps.has('stream')) {
      await page.getByTestId('chat-stream').hover()
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => {
          const el = document.querySelector('[data-testid="chat-stream"]')
          if (el) el.scrollTop = el.scrollHeight
        })
        await page.mouse.wheel(0, 4_000)
        await sleep(200)
      }
      await sleep(SETTLE_MS)
      await sample('stream-0s')
      await stream(wire, seed.longSessionId, seed.sessions[0]!.lastSeq, streamMs, { sample })
      await sample(`stream-${Math.round(streamMs / 1000)}s`)
      await sleep(quick ? 2_000 : 30_000)
      await sample('stream-settled')
    }

    /*
     * background: the long session open, as the person keeps one conversation open, while others stream out of view as
     * workers and linked children do. Every few minutes one of three of them is visited and left again; mail arrives
     * every minute. The window keeps receiving all of it.
     */
    if (steps.has('background')) {
      const streamers = seed.sessions.filter((s) => s.id !== seed.longSessionId).slice(0, BACKGROUND_SESSIONS)
      await row(seed.longSessionId).click()
      await sleep(SETTLE_MS)
      await sample('background-0s')
      const first = await snapshot('background-0s')
      const start = Date.now()
      const over = () => Date.now() - start >= backgroundMs
      const visits = async () => {
        for (let i = 0; !over(); i++) {
          await sleep(quick ? 20_000 : 180_000)
          if (over()) break
          await row(streamers[i % Math.min(3, streamers.length)]!.id).click()
          await sleep(quick ? 3_000 : 15_000)
          await row(seed.longSessionId).click()
        }
      }
      const mail = async () => {
        for (let i = 1; !over(); i++) {
          await sleep(60_000)
          if (over()) break
          const from = streamers[i % streamers.length]!
          wire.inject({
            type: 'mail_changed',
            threadId: `perf.t_${i}`,
            toPerson: true,
            arrived: {
              messageId: `perf.m_${i}`,
              from: { address: `session:perf/${from.id}`, kind: 'session', sessionId: from.id, name: null, state: 'working' },
              kind: 'report',
              preview: `Report ${i}: the window keeps what it was sent`,
            },
          })
        }
      }
      const samples5m = async () => {
        for (let m = 5; m * 60_000 < backgroundMs; m += 5) {
          await sleep(start + m * 60_000 - Date.now())
          await sample(`background-${m}m`)
        }
      }
      await Promise.all([
        ...streamers.map((s) => stream(wire, s.id, s.lastSeq, backgroundMs)),
        visits(),
        mail(),
        samples5m(),
      ])
      await sample(`background-${Math.round(backgroundMs / 60_000)}m`)
      await sleep(quick ? 2_000 : 30_000)
      await sample('background-settled')
      const end = await snapshot('background-end')
      grow('background-0s → background-end', first, end)
    }

    /*
     * revisit: the long session open, as in background, while the person works through the other sessions over the hour,
     * opening each in turn, reading back a page in every other one, and coming back to the long one. A few of them stream
     * out of view meanwhile. Rounds 1 and 2 open every session once and read each back once; the later rounds repeat
     * them, so growth after round 2 is something an open leaves behind (or the streaming). `idle` keeps the streaming and
     * the schedule but opens nothing; `onToolResult` runs for each tool result the streams send.
     */
    const revisit = async (label: string, idle: boolean, onToolResult?: () => void) => {
      const others = seed.sessions.filter((s) => s.id !== seed.longSessionId)
      const ms = REVISIT_ROUNDS * others.length * REVISIT_EVERY_MS
      await sleep(SETTLE_MS)
      await sample(`${label}-0s`)
      const first = await snapshot(`${label}-0s`)
      let afterFirst: Map<string, HeapClasses> | null = null
      const start = Date.now()
      const opens = async () => {
        for (let round = 1; round <= REVISIT_ROUNDS; round++) {
          for (const [i, s] of others.entries()) {
            const n = (round - 1) * others.length + i
            await sleep(start + n * REVISIT_EVERY_MS - Date.now())
            if (idle) continue
            await open(s.id)
            if (n % 2) await pageBack()
            await sleep(quick ? 1_000 : 5_000)
            await open(seed.longSessionId)
          }
          await sample(`${label}-round-${round}`)
          if (round === 1) afterFirst = await snapshot(`${label}-round-1`)
        }
      }
      const streams = others.slice(0, REVISIT_STREAMING).map((s) => stream(wire, s.id, s.lastSeq, ms, { onToolResult }))
      await Promise.all([...streams, opens()])
      await sleep(quick ? 2_000 : 30_000)
      await sample(`${label}-settled`)
      const end = await snapshot(`${label}-end`)
      grow(`${label}-0s → ${label}-round-1`, first, afterFirst)
      grow(`${label}-round-1 → ${label}-end`, afterFirst, end)
    }
    if (steps.has('revisit')) {
      await open(seed.longSessionId)
      await revisit('revisit', false)
    }

    /*
     * appview: an app's view open in the window (an app shaped like the project board, e2e/fixtures/board-app.ts) for the
     * whole of the revisit pattern. Each tool result the streams send also tells the window the app changed, as an
     * agent's call to the board's tools does, so the view reads the board and draws it again; it polls its queue too.
     */
    if (steps.has('appview')) {
      const key = `${boardApp!.projectId}/${boardApp!.appId}`
      await page.getByTestId(`app-row-${key}`).click()
      const proxy = page.getByTestId(`pinned-app-${key}`).getByTestId('app-frame-iframe')
      const card = proxy.contentFrame().locator('iframe').contentFrame().locator('[data-card]').first()
      await card.waitFor({ timeout: 60_000 })
      // Chromium gives a sandboxed frame a renderer of its own, which the page's session does not reach: the view's
      // memory is in `footprintMB.content`, not in the largest content process, and its heap is read through a session
      // on each such frame. A frame in the page's renderer has no session of its own, and its heap is the page's. WebKit
      // runs the view in the window's WebContent.
      if (cdp) {
        const frame = await (await proxy.elementHandle()).contentFrame()
        for (const f of frame ? [frame, ...frame.childFrames()] : []) {
          const s = await context.newCDPSession(f).catch(() => null)
          if (s) viewCdp.push(s)
        }
        console.error(`[${engine}] appview: ${viewCdp.length} of the view's frames run in a renderer of their own`)
      }
      await open(seed.longSessionId)
      const changed = () => wire.inject({ type: 'external_app_state_changed', appId: boardApp!.appId, projectId: boardApp!.projectId })
      await revisit('appview', values['appview-idle'], changed)
      // How many times the view read the board: it says so in every card, whether it is on screen or not
      console.error(`[${engine}] appview: ${await card.textContent({ timeout: 10_000 }).catch(() => 'the view is gone')}`)
    }

    const { sessions: _s, projects: _p, ...rest } = seed
    return { engine, seed: rest, samples, layers, heapGrowth: grown }
  } finally {
    await browser?.close().catch(() => {})
    if (host && host.exitCode === null) {
      host.kill('SIGTERM')
      await new Promise((r) => host!.once('exit', r))
    }
    await new Promise((r) => (server ? server.close(r) : r(null)))
    rmSync(work, { recursive: true, force: true })
  }
}

const results = []
for (const engine of engines) results.push(await measureEngine(engine))
const report = {
  label: values.label,
  profile,
  streamMinutes: streamMs / 60_000,
  streamParts: [...parts],
  turnSteps: TURN_STEPS,
  viewport: VIEWPORT,
  dpr: DPR,
  reducedMotion: values['reduced-motion'],
  frozenAnimations: values['freeze-animations'],
  at: new Date().toISOString(),
  results,
}
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2))

for (const r of results) {
  console.log(`\n## ${values.label} · ${r.engine} · ${profile}\n`)
  console.log(
    '| step | content MB | content after GC | all content MB | all content after GC | total MB | gpu MB | ui MB | ' +
      'JS heap MB | heap after GC | view heap MB | view heap after GC | DOM nodes | rows drawn | rows received | host MB |',
  )
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const s of r.samples) {
    console.log(
      `| ${s.step} | ${s.contentFootprintMB} | ${s.afterGc?.contentFootprintMB ?? '–'} | ${s.footprintMB.content ?? 0} | ` +
        `${s.afterGc?.allContentFootprintMB ?? '–'} | ${s.totalFootprintMB} | ${s.footprintMB.gpu ?? 0} | ${s.footprintMB.ui ?? 0} | ` +
        `${s.heapUsedMB ?? '–'} | ${s.afterGc?.heapUsedMB ?? '–'} | ${s.viewHeapUsedMB ?? '–'} | ${s.afterGc?.viewHeapUsedMB ?? '–'} | ` +
        `${s.domNodes} | ${s.renderedRows} | ${s.rowsReceived} | ${s.hostFootprintMB} |`,
    )
  }
  for (const { span, rows } of r.heapGrowth) {
    console.log(`\n### What the JS heap gained from ${span}, by constructor\n`)
    console.log('| constructor | MB | count |')
    console.log('|---|---:|---:|')
    for (const g of rows) console.log(`| \`${g.name.replace(/\|/g, '\\|')}\` | ${g.mb} | ${g.count} |`)
  }
  if (r.layers) {
    const drawn = r.layers.filter((l) => l.drawsContent)
    console.log(
      `\n### Composited layers in the grid (${r.layers.length}, ${drawn.length} drawing, ` +
        `${round(drawn.reduce((a, l) => a + l.mb, 0))} MB${r.engine === 'chromium' ? ` of area at DPR ${DPR}` : ''})\n`,
    )
    console.log('| panel | element | size | MB | reasons |')
    console.log('|---|---|---:|---:|---|')
    for (const l of [...r.layers].sort((a, b) => a.panel.localeCompare(b.panel) || b.mb - a.mb))
      console.log(
        `| ${l.panel || '–'} | \`${l.node.replace(/\|/g, '\\|')}\` | ${l.width}×${l.height} | ${l.mb} | ${l.reasons.join(', ')} |`,
      )
  }
}
