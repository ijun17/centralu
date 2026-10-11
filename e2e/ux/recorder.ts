import type { Locator, Page } from '@playwright/test'
import { chordKeys, hick, pointing, strokesOf, type Box, type Choice, type Point, type Step } from './klm.js'

/**
 * Drives a task through Playwright and writes down what a person would have done (#518).
 *
 * Every action goes through here rather than through `page` or a locator, so nothing a task does
 * goes uncounted. Keys are real key events (`page.keyboard`), so the app's own handlers decide
 * what they do, and a click is a real pointer move and click at the target's centre, with the
 * distance and the target's size taken from the boxes on screen. Whether a field already has the
 * keyboard is asked of the page, not assumed: typing into a field that does not have focus costs
 * the click a person would need first.
 *
 * What this cannot see, and the task has to say: whether a click selects a command or an argument
 * (`role`), whether a typed string is a constant or a variable one (`string`), and which keys
 * belong to one cognitive unit (`continues`). Those decide where the M's go (klm.ts).
 */
export class Recorder {
  private readonly log: Step[] = []
  private at: Point = { x: 0, y: 0 }
  readonly warnings: string[] = []

  constructor(readonly page: Page) {}

  /** Puts the pointer where the task starts: the middle of the window unless the task says otherwise */
  async begin(start?: Point): Promise<void> {
    const size = this.page.viewportSize() ?? { width: 1280, height: 840 }
    this.at = start ?? { x: Math.round(size.width / 2), y: Math.round(size.height / 2) }
    await this.page.mouse.move(this.at.x, this.at.y)
  }

  steps(): Step[] {
    return [...this.log]
  }

  /**
   * One key or one chord: `Enter`, `ControlOrMeta+k`. A key right after a typed string is read as
   * that string's terminator (Rule 4). `among` is the number of items the key chooses from (or a
   * locator that counts them), reported as a Hick–Hyman note.
   */
  async press(chord: string, opts: { continues?: boolean; redundant?: boolean; among?: Locator | number; label?: string } = {}): Promise<void> {
    const choice = await this.choice(opts.among)
    await this.page.keyboard.press(chord)
    this.log.push({
      kind: 'press',
      label: opts.label ?? chord.replace(/ControlOrMeta/g, 'Mod'),
      keys: chordKeys(chord),
      ...(opts.continues ? { continues: true } : {}),
      ...(opts.redundant ? { redundant: true } : {}),
      ...(choice ? { choice } : {}),
    })
  }

  /**
   * Types a string into whatever has the keyboard, key by key. `variable` (the default) is a
   * string the person makes up or recalls (a message, a search, a name); `constant` is one they
   * know by heart (a command's name).
   */
  async type(text: string, opts: { string?: 'constant' | 'variable'; label?: string } = {}): Promise<void> {
    await this.page.keyboard.type(text)
    this.log.push({ kind: 'type', label: opts.label ?? JSON.stringify(text), text, strokes: strokesOf(text), string: opts.string ?? 'variable' })
  }

  /** Types into a field, clicking it first when it does not have the keyboard */
  async fill(field: Locator, text: string, opts: { string?: 'constant' | 'variable'; label?: string } = {}): Promise<void> {
    if (!(await hasFocus(field))) await this.click(field, { role: 'argument', label: `${opts.label ?? describe(field)} (focus)` })
    await this.type(text, opts)
  }

  /**
   * Points at the target and clicks it. `role: 'command'` (the default) selects something to do
   * and gets an M; `'argument'` places the caret or picks an operand and does not (Rule 0).
   */
  async click(
    target: Locator,
    opts: { role?: 'command' | 'argument'; continues?: boolean; among?: Locator | number; label?: string } = {},
  ): Promise<void> {
    const choice = await this.choice(opts.among)
    const box = await this.boxOf(target)
    const p = pointing(this.at, box)
    await target.click({ position: { x: box.width / 2, y: box.height / 2 } })
    this.at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    this.log.push({
      kind: 'click',
      label: opts.label ?? describe(target),
      role: opts.role ?? 'command',
      pointing: p,
      ...(opts.continues ? { continues: true } : {}),
      ...(choice ? { choice } : {}),
    })
  }

  /** Points at the target without clicking (a hover that reveals something) */
  async point(target: Locator, opts: { label?: string } = {}): Promise<void> {
    const box = await this.boxOf(target)
    const p = pointing(this.at, box)
    this.at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await this.page.mouse.move(this.at.x, this.at.y)
    this.log.push({ kind: 'point', label: opts.label ?? describe(target), pointing: p })
  }

  /**
   * The person waits for the app (R): runs the check and records how long it took. Every place a
   * person would have to look and wait before going on is one of these, and the task's goal check
   * is the last.
   */
  async until(label: string, check: () => Promise<unknown>): Promise<void> {
    const t0 = performance.now()
    await check()
    this.log.push({ kind: 'wait', label, ms: performance.now() - t0 })
  }

  private async choice(among: Locator | number | undefined): Promise<Choice | undefined> {
    if (among === undefined) return undefined
    const n = typeof among === 'number' ? among : await among.count()
    return hick(n)
  }

  /**
   * The target's box as the person sees it. A target outside the window would need a scroll the
   * model does not count, so it is said, not silently priced as if it were in view.
   */
  private async boxOf(target: Locator): Promise<Box> {
    await target.waitFor({ state: 'visible' })
    const before = await target.boundingBox()
    const size = this.page.viewportSize()
    if (before && size && (before.y < 0 || before.x < 0 || before.y + before.height > size.height || before.x + before.width > size.width)) {
      this.warnings.push(`${describe(target)} was outside the window: the scroll to reach it is not counted`)
      await target.scrollIntoViewIfNeeded()
    }
    const box = await target.boundingBox()
    if (!box) throw new Error(`${describe(target)} has no box to point at`)
    return box
  }
}

/** A locator's readable name: its test id when it has one */
function describe(target: Locator): string {
  const s = String(target)
  return /getByTestId\('([^']+)'\)/.exec(s)?.[1] ?? s
}

async function hasFocus(field: Locator): Promise<boolean> {
  return field.evaluate((el) => {
    const active = el.ownerDocument.activeElement
    return active !== null && (el === active || el.contains(active))
  })
}
