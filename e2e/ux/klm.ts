/**
 * The Keystroke-Level Model and Fitts's law, as pure functions (#518, docs/ux-metrics.md).
 *
 * The recorder (recorder.ts) writes down what a task physically did: which keys, which clicks and
 * where the pointer went, which waits. This file turns that into the model's operators: it decides
 * where the hand moves between keyboard and mouse (H), places the mental operators (M) by Card,
 * Moran & Newell's heuristic rules, prices every operator, and sums, compares and checks budgets.
 * No Playwright here, so `tooling/ux-klm.test.ts` tests it without a browser.
 */

export type Operator = 'K' | 'P' | 'B' | 'H' | 'M' | 'R'
export type Hand = 'keyboard' | 'mouse'

/**
 * Seconds per operator. Card, Moran & Newell, *The Psychology of Human-Computer Interaction*
 * (1983), ch. 8, and the KLM paper (Card, Moran & Newell, "The keystroke-level model for user
 * performance time with interactive systems", CACM 23(7), 1980), Fig. 1.
 *
 * - K 0.28 s: the average non-secretary typist (40 wpm). The model's table runs from 0.08 s (the
 *   best typist, 135 wpm) through 0.2 s (an average skilled typist, 55 wpm) to 1.2 s (someone who
 *   does not know the keyboard). The slower value because the people this is for are not all
 *   developers; one value for every task, so two runs stay comparable.
 * - B 0.1 s: pressing *or* releasing a mouse button. A click is B B.
 * - H 0.4 s: moving the hand between the keyboard and the mouse.
 * - M 1.35 s: mental preparation, placed by the rules in `placeMentals`.
 */
export const SECONDS = { K: 0.28, B: 0.1, H: 0.4, M: 1.35 } as const

/**
 * Fitts's law in its Shannon form (MacKenzie 1992): `T = a + b·log2(D/W + 1)`.
 *
 * b = 0.1 s/bit is Card, Moran & Newell's Model Human Processor value for Fitts's slope (I_M,
 * 100 ms/bit, range 70–120). a = 0.8 s is this project's choice, not a fitted constant: it makes a
 * target of 3 bits (D/W = 7, a typical toolbar button across a window) cost the KLM's average P of
 * 1.1 s, so that a Fitts-priced P and the textbook P agree where they should. What the numbers are
 * for is comparing two versions of a task, and for that a and b only have to stay fixed.
 */
export const FITTS = { a: 0.8, b: 0.1 } as const

/**
 * Hick–Hyman law, `T = I_C · log2(n + 1)` with I_C = 0.15 s/bit (Card, Moran & Newell 1983, the
 * Model Human Processor's choice reaction; Hick 1952, Hyman 1953). Reported beside a choice among
 * n items as a note: KLM's M already stands for the decision, so adding this too would count it twice.
 */
export const HICK_BITS_SECONDS = 0.15

export type Box = { x: number; y: number; width: number; height: number }
export type Point = { x: number; y: number }

/** Where a pointing went and how hard the target was to hit */
export type Pointing = {
  from: Point
  to: Point
  /** Distance travelled, in CSS pixels */
  D: number
  /** The target's width along the line of approach, in CSS pixels */
  W: number
  /** Index of difficulty, log2(D/W + 1), in bits */
  ID: number
  seconds: number
}

/** A choice among n alternatives, priced by Hick–Hyman (a note, not part of the time) */
export type Choice = { n: number; bits: number; seconds: number }

/**
 * One thing the task did, as the recorder saw it. The operators come from these in `encode`.
 *
 * - `press`: one key or one chord (`ControlOrMeta+k` is two keys, one cognitive unit).
 * - `type`: a text string, one K per key (a capital or a shifted symbol is two: Shift and the key).
 * - `click`: point and click, P B B. `role` says whether the click selects a command (it gets an M)
 *   or an argument (placing the caret in a field: no M), Rule 0.
 * - `point`: point without clicking (hover to reveal), P.
 * - `wait`: the person waits for the app, R, measured.
 */
export type Step =
  | {
      kind: 'press'
      label: string
      keys: string[]
      /** Same cognitive unit as the step before (Rule 2): `ArrowDown ArrowDown` to the second item */
      continues?: boolean
      /** Terminates something already terminated (Rule 3) */
      redundant?: boolean
      choice?: Choice
    }
  | { kind: 'type'; label: string; text: string; strokes: number; string: 'constant' | 'variable' }
  | { kind: 'click'; label: string; role: 'command' | 'argument'; continues?: boolean; pointing: Pointing | null; choice?: Choice }
  | { kind: 'point'; label: string; pointing: Pointing | null }
  | { kind: 'wait'; label: string; ms: number }

/** An operator with its price, the step it came from, and why it is there */
export type Op = { op: Operator; seconds: number; step: number; why?: string }

/** Keys a string costs: one per character, plus Shift for a capital or a shifted symbol */
export function strokesOf(text: string): number {
  let n = 0
  for (const ch of text) n += /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch) ? 2 : 1
  return n
}

/** `ControlOrMeta+Shift+a` → the keys pressed together */
export function chordKeys(chord: string): string[] {
  // Split the way Playwright's keyboard does: a '+' with nothing before it is the key itself (`Shift++`)
  const keys: string[] = []
  let building = ''
  for (const ch of chord) {
    if (ch === '+' && building) {
      keys.push(building)
      building = ''
    } else building += ch
  }
  keys.push(building)
  return keys
}

/**
 * The target's width along the line of approach (MacKenzie & Buxton 1992): the chord of the box
 * through its centre in the direction of travel. Coming in level, a wide button is wide; coming
 * in from above, the same button is only as wide as it is tall.
 */
export function widthAlong(box: Box, dx: number, dy: number): number {
  const len = Math.hypot(dx, dy)
  if (len === 0) return Math.min(box.width, box.height)
  const ux = Math.abs(dx) / len
  const uy = Math.abs(dy) / len
  const across = ux > 0 ? box.width / ux : Infinity
  const down = uy > 0 ? box.height / uy : Infinity
  return Math.min(across, down)
}

export function fittsSeconds(D: number, W: number, c: { a: number; b: number } = FITTS): number {
  return c.a + c.b * Math.log2(D / W + 1)
}

/**
 * The pointing from `from` to the centre of `box`, or null when the pointer is already inside the
 * box: nothing to point at, the person only clicks.
 */
export function pointing(from: Point, box: Box, c: { a: number; b: number } = FITTS): Pointing | null {
  const inside = from.x >= box.x && from.x <= box.x + box.width && from.y >= box.y && from.y <= box.y + box.height
  if (inside) return null
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const dx = to.x - from.x
  const dy = to.y - from.y
  const D = Math.hypot(dx, dy)
  const W = widthAlong(box, dx, dy)
  const ID = Math.log2(D / W + 1)
  return { from, to, D, W, ID, seconds: fittsSeconds(D, W, c) }
}

export function hick(n: number): Choice {
  const bits = Math.log2(n + 1)
  return { n, bits, seconds: HICK_BITS_SECONDS * bits }
}

/**
 * The physical operators of the steps, with the hand switches, and every M candidate that Rule 0
 * asks for. Each M carries the rule that decides whether it stays, applied by `placeMentals`.
 */
type Candidate = Op & { rule?: 'keep' | 'rule1?' | 'rule2' | 'rule3' | 'rule4-constant' | 'rule4-variable' }

function physical(steps: Step[], hand: Hand): Candidate[] {
  const out: Candidate[] = []
  let at = hand
  const reach = (to: Hand, step: number) => {
    if (at === to) return
    out.push({ op: 'H', seconds: SECONDS.H, step, why: `hand to the ${to}` })
    at = to
  }
  steps.forEach((s, i) => {
    const before = previousAction(steps, i)
    if (s.kind === 'press') {
      reach('keyboard', i)
      // A key that ends a string just typed is its terminator (Rule 4); any other key is a command (Rule 0)
      const terminates = before?.kind === 'type'
      const rule: Candidate['rule'] = s.redundant
        ? 'rule3'
        : s.continues
          ? 'rule2'
          : terminates
            ? before.string === 'constant'
              ? 'rule4-constant'
              : 'rule4-variable'
            : 'rule1?'
      out.push({ op: 'M', seconds: SECONDS.M, step: i, rule })
      for (const _ of s.keys) out.push({ op: 'K', seconds: SECONDS.K, step: i })
    } else if (s.kind === 'type') {
      reach('keyboard', i)
      // Rule 0: no M inside a text string proper
      for (let k = 0; k < s.strokes; k++) out.push({ op: 'K', seconds: SECONDS.K, step: i })
    } else if (s.kind === 'click') {
      reach('mouse', i)
      // Rule 0: an M before a P that selects a command, none before one that selects an argument
      if (s.role === 'command') out.push({ op: 'M', seconds: SECONDS.M, step: i, rule: s.continues ? 'rule2' : 'rule1?' })
      if (s.pointing) out.push({ op: 'P', seconds: s.pointing.seconds, step: i })
      // Rule 1 by construction: the button press is anticipated by the pointing, so never an M between P and B
      out.push({ op: 'B', seconds: SECONDS.B, step: i }, { op: 'B', seconds: SECONDS.B, step: i })
    } else if (s.kind === 'point') {
      reach('mouse', i)
      if (s.pointing) out.push({ op: 'P', seconds: s.pointing.seconds, step: i })
    } else {
      out.push({ op: 'R', seconds: 0, step: i })
    }
  })
  return out
}

/** The step before `i` that the person did, skipping waits */
function previousAction(steps: Step[], i: number): Step | undefined {
  for (let j = i - 1; j >= 0; j--) if (steps[j]!.kind !== 'wait') return steps[j]
  return undefined
}

/**
 * Card, Moran & Newell's heuristic rules for placing M (1980, Fig. 2; 1983, p. 265), applied to
 * the candidates Rule 0 produced:
 *
 * - Rule 0: an M before every K that is not part of a text string proper, and before every P that
 *   selects a command (not an argument). `physical` puts them there, one per key or chord.
 * - Rule 1: if the operator after an M is fully anticipated by the one just before it, delete the
 *   M (P M K → P K). Applied here to an M between a P and a K or B. A click never gets an M
 *   between its P and its B in the first place.
 * - Rule 2: if a string of MKs belongs to one cognitive unit, delete all M's but the first. A chord
 *   is one press, so one M; a step marked `continues` belongs to the unit before it.
 * - Rule 3: if a K is a redundant terminator, delete the M before it.
 * - Rule 4: if a K terminates a constant string (a command name), delete the M before it; if it
 *   terminates a variable string (an argument: a message, a search), keep it.
 */
export function placeMentals(candidates: Candidate[]): Op[] {
  const out: Op[] = []
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    if (c.op !== 'M') {
      out.push(strip(c))
      continue
    }
    if (c.rule === 'rule2' || c.rule === 'rule3' || c.rule === 'rule4-constant') continue
    if (c.rule === 'rule1?') {
      const prev = lastPhysical(out)
      const next = candidates[i + 1]
      if (prev?.op === 'P' && (next?.op === 'K' || next?.op === 'B')) continue
    }
    out.push(strip(c))
  }
  return out
}

function strip(c: Candidate): Op {
  const { rule: _, ...op } = c
  return op
}

/** The last operator that is a movement of the hand or the pointer (H and R do not anticipate anything) */
function lastPhysical(ops: Op[]): Op | undefined {
  for (let i = ops.length - 1; i >= 0; i--) if (ops[i]!.op !== 'H' && ops[i]!.op !== 'R') return ops[i]
  return undefined
}

/** The operators of a task: hand switches, M's by the rules, every operator priced */
export function encode(steps: Step[], hand: Hand): Op[] {
  return placeMentals(physical(steps, hand))
}

/**
 * The operators as one line, runs of three or more written once with their count (`M 2K` stays
 * `M K K`, twelve typed keys are `12K`).
 */
export function operatorString(ops: Op[]): string {
  const parts: string[] = []
  for (let i = 0; i < ops.length; ) {
    let j = i
    while (j < ops.length && ops[j]!.op === ops[i]!.op) j++
    const n = j - i
    if (n >= 3) parts.push(`${n}${ops[i]!.op}`)
    else for (let k = 0; k < n; k++) parts.push(ops[i]!.op)
    i = j
  }
  return parts.join(' ')
}

export type Counts = Record<Operator, number>

export function countOps(ops: Op[]): Counts {
  const counts: Counts = { K: 0, P: 0, B: 0, H: 0, M: 0, R: 0 }
  for (const o of ops) counts[o.op]++
  return counts
}

/** A step as the report shows it */
export type StepReport = {
  kind: Step['kind']
  label: string
  operators: string
  seconds: number
  pointer?: { D: number; W: number; ID: number }
  choice?: Choice
  waitMs?: number
}

export type TaskResult = {
  id: string
  task: string
  path: 'keyboard' | 'mouse' | 'mixed'
  operators: string
  counts: Counts
  /** KLM execution time: every operator but R, in seconds */
  seconds: number
  /** Measured time the task waited on the app (R), in milliseconds. Not part of `seconds`: see docs/ux-metrics.md */
  waitMs: number
  /** Total pointer travel, in CSS pixels */
  travelPx: number
  steps: StepReport[]
  notes: string[]
  /** Budget lines this run went over (empty when within budget or none declared) */
  breaches: string[]
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits

export function analyse(
  meta: { id: string; task: string; path: TaskResult['path']; notes?: string[] },
  steps: Step[],
  hand: Hand,
): Omit<TaskResult, 'breaches'> {
  const ops = encode(steps, hand)
  const counts = countOps(ops)
  const seconds = ops.reduce((t, o) => t + o.seconds, 0)
  const waitMs = steps.reduce((t, s) => t + (s.kind === 'wait' ? s.ms : 0), 0)
  const travelPx = steps.reduce((t, s) => t + ((s.kind === 'click' || s.kind === 'point') && s.pointing ? s.pointing.D : 0), 0)
  const notes = [...(meta.notes ?? [])]
  const reports = steps.map<StepReport>((s, i) => {
    const mine = ops.filter((o) => o.step === i)
    const r: StepReport = { kind: s.kind, label: s.label, operators: operatorString(mine), seconds: round(mine.reduce((t, o) => t + o.seconds, 0)) }
    if ((s.kind === 'click' || s.kind === 'point') && s.pointing) {
      r.pointer = { D: Math.round(s.pointing.D), W: Math.round(s.pointing.W), ID: round(s.pointing.ID) }
    }
    if ((s.kind === 'press' || s.kind === 'click') && s.choice) {
      r.choice = { n: s.choice.n, bits: round(s.choice.bits), seconds: round(s.choice.seconds) }
    }
    if (s.kind === 'wait') r.waitMs = Math.round(s.ms)
    return r
  })
  for (const r of reports) {
    if (r.choice) notes.push(`${r.label}: a choice among ${r.choice.n} (Hick–Hyman ${r.choice.seconds} s, not added)`)
  }
  return {
    id: meta.id,
    task: meta.task,
    path: meta.path,
    operators: operatorString(ops.filter((o) => o.op !== 'R')),
    counts,
    seconds: round(seconds),
    waitMs: Math.round(waitMs),
    travelPx: Math.round(travelPx),
    steps: reports,
    notes,
  }
}

/**
 * Upper bounds a task may declare. `operators` counts every operator but R; the letters bound one
 * operator each. A run over any of them fails (docs/ux-metrics.md, "Budgets").
 */
export type Budget = {
  seconds?: number
  operators?: number
  travelPx?: number
} & Partial<Record<Exclude<Operator, 'R'>, number>>

export function budgetBreaches(r: Pick<TaskResult, 'seconds' | 'counts' | 'travelPx'>, budget: Budget | undefined): string[] {
  if (!budget) return []
  const out: string[] = []
  const operators = r.counts.K + r.counts.P + r.counts.B + r.counts.H + r.counts.M
  if (budget.seconds !== undefined && r.seconds > budget.seconds) out.push(`KLM time ${r.seconds} s > budget ${budget.seconds} s`)
  if (budget.operators !== undefined && operators > budget.operators) out.push(`operators ${operators} > budget ${budget.operators}`)
  if (budget.travelPx !== undefined && r.travelPx > budget.travelPx) out.push(`pointer travel ${r.travelPx} px > budget ${budget.travelPx} px`)
  for (const op of ['K', 'P', 'B', 'H', 'M'] as const) {
    const max = budget[op]
    if (max !== undefined && r.counts[op] > max) out.push(`${op} ${r.counts[op]} > budget ${max}`)
  }
  return out
}

/** A task the suite cannot run yet: its feature is not merged */
export type PendingTask = { id: string; task: string; path: TaskResult['path']; waitingOn: string; reason: string }

export type Report = {
  version: 1
  engine: string
  constants: { seconds: typeof SECONDS; fitts: typeof FITTS; hickSecondsPerBit: number }
  tasks: TaskResult[]
  pending: PendingTask[]
}

export function makeReport(engine: string, tasks: TaskResult[], pending: PendingTask[]): Report {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return {
    version: 1,
    engine,
    constants: { seconds: SECONDS, fitts: FITTS, hickSecondsPerBit: HICK_BITS_SECONDS },
    tasks: [...tasks].sort(byId),
    pending: [...pending].sort(byId),
  }
}

const opsTotal = (c: Counts) => c.K + c.P + c.B + c.H + c.M
const cell = (s: string) => s.replace(/\|/g, '\\|')

/** The report as a Markdown table, one row per task, then the pending tasks */
export function formatReport(r: Report): string {
  const lines = [
    `| Task | Path | Operators | K | P | B | H | M | Ops | KLM s | Travel px | R (measured ms) |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ]
  for (const t of r.tasks) {
    const c = t.counts
    lines.push(
      `| ${cell(t.id)} | ${t.path} | \`${t.operators}\` | ${c.K} | ${c.P} | ${c.B} | ${c.H} | ${c.M} | ${opsTotal(c)} | ${t.seconds.toFixed(2)} | ${t.travelPx} | ${c.R} (${t.waitMs}) |`,
    )
  }
  if (r.pending.length > 0) {
    lines.push('', '| Pending task | Path | Waiting on | Why |', '|---|---|---|---|')
    for (const p of r.pending) lines.push(`| ${cell(p.id)} | ${p.path} | ${p.waitingOn} | ${cell(p.reason)} |`)
  }
  const breached = r.tasks.filter((t) => t.breaches.length > 0)
  if (breached.length > 0) {
    lines.push('', 'Over budget:')
    for (const t of breached) for (const b of t.breaches) lines.push(`- ${t.id}: ${b}`)
  }
  return lines.join('\n')
}

const signed = (n: number, digits = 0) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toFixed(digits)

/**
 * Two runs side by side: for each task, the operator counts and KLM time before and after, and
 * what changed. A task in only one run is listed as added or removed.
 */
export function compareReports(a: Report, b: Report): string {
  const before = new Map(a.tasks.map((t) => [t.id, t]))
  const after = new Map(b.tasks.map((t) => [t.id, t]))
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort()
  const lines = [`| Task | Ops before → after | KLM s before → after | Δ s | Travel px Δ | Operators after |`, `|---|---|---|---|---|---|`]
  for (const id of ids) {
    const x = before.get(id)
    const y = after.get(id)
    if (!x && y) lines.push(`| ${cell(id)} | added → ${opsTotal(y.counts)} | — → ${y.seconds.toFixed(2)} | | | \`${y.operators}\` |`)
    else if (x && !y) lines.push(`| ${cell(id)} | ${opsTotal(x.counts)} → removed | ${x.seconds.toFixed(2)} → — | | | |`)
    else if (x && y) {
      const ds = y.seconds - x.seconds
      const changed = x.operators !== y.operators ? ` (was \`${x.operators}\`)` : ''
      lines.push(
        `| ${cell(id)} | ${opsTotal(x.counts)} → ${opsTotal(y.counts)} | ${x.seconds.toFixed(2)} → ${y.seconds.toFixed(2)} | ${signed(ds, 2)} | ${signed(y.travelPx - x.travelPx)} | \`${y.operators}\`${changed} |`,
      )
    }
  }
  return lines.join('\n')
}
