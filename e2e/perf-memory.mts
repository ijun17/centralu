/**
 * What the window costs in memory against a heavy store (#364 "Performance").
 *
 *   pnpm perf:memory [--profile small|owner|stress] [--engines webkit,chromium] [--stream-minutes 5]
 *                    [--ui-root <checkout>] [--label <name>] [--out <file.json>] [--quick]
 *                    [--steps blank,shell,long,scrolled,grid,switched,stream] [--dpr 2]
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
 *
 * Each step samples the browser's processes (footprint from `top`, the number Activity Monitor shows, and RSS
 * from `ps`), the page's DOM, its rendered conversation rows and running animations, and in Chromium the JS heap
 * over CDP, also after a forced collection.
 *
 * The streaming is not a model: the page's socket to the host is routed through Playwright (`routeWebSocket`) and
 * the events are injected there, in the host's own envelope, with the host's later event numbers shifted past
 * them. The window cannot tell them from a host's. Nothing reaches a model, and the host's store is not written.
 *
 * Only processes this script started are measured, and none are signalled but its own host. WebKit's helper
 * processes are XPC services with no parent link, so they are told apart as the WebKit processes that were not
 * there before the launch — hold the e2e lock while this runs:
 *   until mkdir /tmp/centralu-e2e.lock 2>/dev/null; do sleep 20; done; pnpm perf:memory; rmdir /tmp/centralu-e2e.lock
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
import { screenshotPng, seedHeavyStore, type SeedSummary, type StoreProfile } from './fixtures/heavy-store.js'
import { freePort } from './fixtures/real-host.js'

const root = fileURLToPath(new URL('../', import.meta.url))

/** What the synthetic stream is made of; leaving parts out tells which of them the memory goes to */
const STREAM_PARTS = ['working', 'text', 'reasoning', 'tools', 'subagent', 'images', 'background'] as const
type StreamPart = (typeof STREAM_PARTS)[number]
const STEPS = ['blank', 'shell', 'long', 'scrolled', 'grid', 'switched', 'stream'] as const
type Step = (typeof STEPS)[number]

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'owner' },
    engines: { type: 'string', default: 'webkit,chromium' },
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
  },
})
const profile = values.profile as StoreProfile
const engines = values.engines.split(',') as Engine[]
const streamMs = Number(values['stream-minutes']) * 60_000
const quick = values.quick
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
  /** The largest content process — the page's own */
  contentFootprintMB: number
  hostFootprintMB: number
  processes: number
  heapUsedMB: number | null
  heapTotalMB: number | null
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
  /** Chromium only: the same after a forced collection, which tells what is held from what is merely not yet collected */
  afterGc: { contentFootprintMB: number; heapUsedMB: number | null } | null
  /** The last injected text is in the page */
  painted: boolean | null
}

// ── Processes ──────────────────────────────────────────────────────────────────────────────

function psTable(): { pid: number; ppid: number; rssKB: number; command: string }[] {
  return execFileSync('ps', ['-Ao', 'pid=,ppid=,rss=,command='], { maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), command: m[4]! }))
}

/** `top`'s MEM column is the physical footprint — what Activity Monitor calls Memory. Reading it asks for nothing */
function footprints(): Map<number, number> {
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
  if (!command.includes('Chrome for Testing') && !command.includes('Chromium')) return null
  if (command.includes('--type=renderer')) return 'content'
  if (command.includes('--type=gpu-process')) return 'gpu'
  if (command.includes('--type=utility')) return command.includes('network') ? 'network' : 'other'
  if (command.includes('--type=')) return 'other'
  return 'ui'
}

/** WebKit's helpers belong to launchd, not to the browser: they are the WebKit processes that are new since launch */
function engineProcs(engine: Engine, before: Set<number>, hostPid: number): { procs: Proc[]; host: number } {
  const table = psTable()
  const fp = footprints()
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

/** A deterministic turn loop at a model's pace: ~70 tokens a second, a tool call every few seconds */
async function stream(
  wire: Wire,
  sessionId: string,
  firstSeq: number,
  ms: number,
  sample: (step: string) => Promise<void>,
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
  const marks = [60_000, 150_000, ms].filter((t) => t <= ms)
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
              readOnly: false,
              paths: [],
            }
          : { tool: 'Bash', title: 'pnpm exec vitest run --maxWorkers=4', readOnly: false, paths: [] },
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
                readOnly: true,
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
        if (t < ms) await sample(`stream-${Math.round(t / 1000)}s`)
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
  const r = spawnSync(
    'pnpm',
    [
      'exec',
      'vite',
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
    const wire = new Wire()
    await wire.attach(context, hostPort)
    const page = await context.newPage()
    const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null
    const t0 = Date.now()

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
          ...(await pageCounts(page)),
          jsEventListeners: null,
          rowsReceived: wire.rowsReceived,
          wsBytesIn: wire.bytesIn,
          afterGc: null,
          painted: wire.lastText
            ? await page.evaluate((t) => document.body.innerText.includes(t.trim()), wire.lastText)
            : null,
        })
      }
      // The median repetition by total footprint, whole, so its numbers belong together
      const pick = reps.find((s) => s.totalFootprintMB === median(reps.map((x) => x.totalFootprintMB)))!
      const h = await heap(cdp)
      pick.jsEventListeners = h.jsEventListeners
      if (cdp) {
        await cdp.send('HeapProfiler.collectGarbage')
        await sleep(1_000)
        const { procs } = engineProcs(engine, before, host!.pid!)
        const after = await heap(cdp)
        pick.afterGc = {
          contentFootprintMB: round(
            Math.max(0, ...procs.filter((p) => p.role === 'content').map((p) => p.footprintMB)),
          ),
          heapUsedMB: after.heapUsedMB === null ? null : round(after.heapUsedMB),
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
      }
      samples.push(out)
      console.error(
        `[${engine}] ${step.padEnd(14)} content=${out.contentFootprintMB}MB total=${out.totalFootprintMB}MB heap=${out.heapUsedMB ?? '-'}MB ` +
          `gc=${out.afterGc ? `${out.afterGc.contentFootprintMB}/${out.afterGc.heapUsedMB}MB` : '-'} nodes=${out.domNodes} rows=${out.renderedRows} ` +
          `received=${out.rowsReceived} host=${out.hostFootprintMB}MB painted=${out.painted ?? '-'}`,
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
      await page.getByTestId('chat-stream').hover()
      for (let i = 0; i < 20; i++) {
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
        await row(s.id).click()
        await page
          .locator('[data-testid="chat-stream"] [data-index]')
          .first()
          .waitFor({ timeout: 30_000 })
          .catch(() => {})
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
      await stream(wire, seed.longSessionId, seed.sessions[0]!.lastSeq, streamMs, sample)
      await sample(`stream-${Math.round(streamMs / 1000)}s`)
      await sleep(quick ? 2_000 : 30_000)
      await sample('stream-settled')
    }

    const { sessions: _s, projects: _p, ...rest } = seed
    return { engine, seed: rest, samples, layers }
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
    '| step | content MB | content after GC | total MB | gpu MB | ui MB | JS heap MB | heap after GC | DOM nodes | rows drawn | rows received | host MB |',
  )
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const s of r.samples) {
    console.log(
      `| ${s.step} | ${s.contentFootprintMB} | ${s.afterGc?.contentFootprintMB ?? '–'} | ${s.totalFootprintMB} | ${s.footprintMB.gpu ?? 0} | ${s.footprintMB.ui ?? 0} | ` +
        `${s.heapUsedMB ?? '–'} | ${s.afterGc?.heapUsedMB ?? '–'} | ${s.domNodes} | ${s.renderedRows} | ${s.rowsReceived} | ${s.hostFootprintMB} |`,
    )
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
