/**
 * Shared looks stay shared: a component file outside packages/ui/src/components/ may not draw a button, a text
 * field, a small caps label or a capsule by hand (owner, 2026-10-18).
 *
 * Simple looks used to be written as class strings at every call site, and each new screen copied the nearest one:
 * 97 framed buttons, 29 framed inputs and 20 small caps labels, with paddings, hover colours and the disabled fade
 * drifting between the copies, and a pick-one toggle copied into six files. They are components now (Button,
 * Segmented, Pill, Badge, TextInput and TextField in packages/ui/src/components/), and this is what keeps the next
 * screen from copying a class string again. What counts as each look is defined in tooling/hand-made-looks.ts.
 *
 * ALLOWED lists the sites that still draw one by hand, each with its reason. It can only shrink: a listed count
 * that is higher than what the file holds fails too, so a site that moves takes its line out of the list in the
 * same change, and the list never says more than is true.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scan, type Look } from './hand-made-looks.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const UI = join(ROOT, 'packages/ui/src')

/** Where each look lives now, for the failure message */
const USE: Record<Look, string> = {
  button: 'Button (components/Button.tsx), or Segmented for one-of-several',
  input: 'TextInput or TextField (components/TextField.tsx)',
  badge: 'Badge (components/Badge.tsx)',
  capsule: 'Pill (components/Pill.tsx)',
}

type Allowed = { file: string; look: Look; count: number; why: string }

/** #1160's capsule actions: a waiting card's or a waiting row's answers in a rounded-full frame (owner, 2026-10-18) */
const CAPSULE_ACTION = "#1160's capsule action (owner, 2026-10-18); Button has no capsule shape yet, the next step for these"

const ALLOWED: Allowed[] = [
  // Not a framed text button: tiles, cards and rows that only share the frame
  { file: 'features/approval/QuestionCard.tsx', look: 'button', count: 3, why: 'answer options are selectable cards lit by a white edge, and Answer is ' + CAPSULE_ACTION },
  { file: 'features/onboarding/Intro.tsx', look: 'button', count: 1, why: 'a tool card of the first run, large and two-lined' },
  { file: 'features/orchestrator/OrchestratorView.tsx', look: 'button', count: 3, why: 'two approve buttons brighter than primary on purpose (a proposal waits on the person), and the suggestion tiles' },
  { file: 'features/palette/SearchField.tsx', look: 'button', count: 1, why: 'the search box of the top bar, a button shaped as a field' },
  { file: 'features/sidebar/GridButton.tsx', look: 'button', count: 1, why: 'a sidebar navigation tile (rounded-lg), lit while its screen is open' },
  { file: 'features/sidebar/OrchestratorButton.tsx', look: 'button', count: 1, why: 'a sidebar navigation tile (rounded-lg), lit while its screen is open' },
  { file: 'features/session/chat-stream/StickyUser.tsx', look: 'button', count: 2, why: 'the pinned user message, a message bubble that opens when pressed' },
  // Capsule actions and capsules whose shape no shared component has yet
  { file: 'features/approval/QuestionCard.tsx', look: 'capsule', count: 1, why: 'Answer, ' + CAPSULE_ACTION },
  { file: 'features/approval/RowApproval.tsx', look: 'button', count: 3, why: 'Allow / Deny / Open with a key hint, ' + CAPSULE_ACTION + '; sized to a slot the row measures its fit against' },
  { file: 'features/approval/RowApproval.tsx', look: 'capsule', count: 3, why: 'the same three answers, ' + CAPSULE_ACTION },
  { file: 'features/inbox/Inbox.tsx', look: 'button', count: 2, why: "a waiting row's answers, " + CAPSULE_ACTION },
  { file: 'features/inbox/Inbox.tsx', look: 'capsule', count: 2, why: 'the same two answers, ' + CAPSULE_ACTION },
  {
    file: 'features/inbox/InboxPill.tsx',
    look: 'button',
    count: 1,
    why: "the inbox capsule: its peek line grows out of it with no flex gap and its own line heights (measured offsets), which Pill's bar size sets",
  },
  { file: 'features/inbox/InboxPill.tsx', look: 'capsule', count: 1, why: 'the inbox capsule, as above' },
  { file: 'features/session/BackgroundTasks.tsx', look: 'button', count: 1, why: 'the background work capsule: 24px, its edge and ink follow running, ended and failed work' },
  { file: 'features/session/BackgroundTasks.tsx', look: 'capsule', count: 3, why: 'the background work capsule, and two status dots (a ring and a dashed ring), not capsules' },
  { file: 'features/session/SessionSettings.tsx', look: 'button', count: 1, why: "the session's model and permission menu trigger, a capsule held lit while its menu is open" },
  { file: 'features/session/SessionSettings.tsx', look: 'capsule', count: 1, why: 'the same trigger' },
  {
    file: 'features/session/SessionStart.tsx',
    look: 'capsule',
    count: 1,
    why: "#1160's segmented tool switch (owner, 2026-10-18): options without frames inside one capsule, holding a loading placeholder; Segmented frames each option",
  },
  { file: 'features/session/chat-rows/CentraluCall.tsx', look: 'button', count: 1, why: 'the session a Centralu call reached, a 24px chip that opens it' },
  { file: 'features/session/chat-rows/CentraluCall.tsx', look: 'capsule', count: 1, why: 'the same chip' },
  { file: 'features/usage/UsageDonuts.tsx', look: 'capsule', count: 1, why: "a linked machine's donuts, drawn by an outline only (owner, 2026-10-18)" },
  // A look no variant has yet
  { file: 'features/machines/MachineTag.tsx', look: 'button', count: 1, why: 'the machine badge, a chip whose solid or dashed edge says whether the link is up' },
  { file: 'features/project/NewSessionDialog.tsx', look: 'button', count: 1, why: 'pick-several chips of the files to copy, not one of several' },
  { file: 'features/settings/MachinesSection.tsx', look: 'button', count: 1, why: 'the uninstall confirmation: a plain frame in danger ink; the danger variant would add its fill' },
  { file: 'features/settings/TypographySection.tsx', look: 'button', count: 1, why: 'text size steps: each shows its own size, larger than any Segmented size' },
  {
    file: 'features/settings/AddMachineForm.tsx',
    look: 'button',
    count: 1,
    why: 'the ssh hosts list: pressing the picked host asks it again, which Segmented (a press on the picked option does nothing) cannot do',
  },
]

/** Every component file of the UI outside the shared components, tests left out */
function sources(): string[] {
  return readdirSync(UI, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split('\\').join('/'))
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.') && !f.startsWith('components/'))
    .sort()
}

function counts(): Map<string, number> {
  const out = new Map<string, number>()
  for (const file of sources()) {
    for (const site of scan(readFileSync(join(UI, file), 'utf8'), file)) {
      const key = `${file} ${site.look}`
      out.set(key, (out.get(key) ?? 0) + 1)
    }
  }
  return out
}

describe('shared looks are drawn by the shared components', () => {
  const found = counts()
  const allowed = new Map(ALLOWED.map((a) => [`${a.file} ${a.look}`, a]))

  it('reads the UI sources', () => {
    expect(sources().length).toBeGreaterThan(100)
  })

  it('no component draws a button, a field, a small caps label or a capsule by hand beyond the list', () => {
    const extra: string[] = []
    for (const [key, n] of found) {
      const [file, look] = key.split(' ') as [string, Look]
      const listed = allowed.get(key)?.count ?? 0
      if (n > listed) {
        const lines = scan(readFileSync(join(UI, file), 'utf8'), file)
          .filter((s) => s.look === look)
          .map((s) => s.line)
        extra.push(`packages/ui/src/${file} (lines ${lines.join(', ')}) draws the ${look} look by hand: use ${USE[look]}`)
      }
    }
    expect(extra).toEqual([])
  })

  it('the list holds only sites that are still there, so it can only shrink', () => {
    const stale = ALLOWED.filter((a) => (found.get(`${a.file} ${a.look}`) ?? 0) < a.count).map(
      (a) => `${a.file} ${a.look}: listed ${a.count}, found ${found.get(`${a.file} ${a.look}`) ?? 0}; lower the count or remove the line`,
    )
    expect(stale).toEqual([])
  })

  it('every listed site says why it stays', () => {
    for (const a of ALLOWED) {
      expect(existsSync(join(UI, a.file)), a.file).toBe(true)
      expect(a.why.length, `${a.file} ${a.look}`).toBeGreaterThan(10)
      expect(a.count, `${a.file} ${a.look}`).toBeGreaterThan(0)
    }
    const keys = ALLOWED.map((a) => `${a.file} ${a.look}`)
    expect(keys.length).toBe(new Set(keys).size)
  })
})

describe('what counts as a hand-made look', () => {
  const looks = (src: string) => scan(src).map((s) => s.look)

  it('a framed button: a <button> with border and a radius', () => {
    expect(looks('<button className="rounded-md border border-line px-2 text-xs">x</button>')).toEqual(['button'])
    expect(looks('<button className={`rounded-lg border ${on ? "a" : "b"}`}>x</button>')).toEqual(['button'])
    // A border only on hover, one side only, or no radius is not the framed button
    expect(looks('<button className="rounded-md hover:border px-2">x</button>')).toEqual([])
    expect(looks('<button className="rounded-md border-b border-line">x</button>')).toEqual([])
    expect(looks('<button className="border border-line">x</button>')).toEqual([])
    expect(looks('<div className="rounded-md border border-line">x</div>')).toEqual([])
  })

  it('reads a class string through a const of the same file and through every branch of a ternary', () => {
    expect(looks('const cls = "rounded-md border px-2"\nconst A = () => <button className={cls}>x</button>')).toEqual(['button'])
    expect(looks('const A = () => <button className={on ? "rounded-md" : "border"}>x</button>')).toEqual(['button'])
  })

  it('a framed text field: an <input> with a border, unless it is a swatch or a box to tick', () => {
    expect(looks('<input className="w-full rounded-md border border-line" />')).toEqual(['input'])
    expect(looks('<input type="text" className="border" />')).toEqual(['input'])
    expect(looks('<input type="color" className="h-5 w-8 rounded-sm border" />')).toEqual([])
    expect(looks('<input type="checkbox" className="border" />')).toEqual([])
    expect(looks('<input className="min-w-0 flex-1 bg-transparent outline-none" />')).toEqual([])
  })

  it('a small caps label: text-2xs with uppercase, on any element', () => {
    expect(looks('<h3 className="readout text-2xs uppercase text-ink-faint">x</h3>')).toEqual(['badge'])
    expect(looks('<span className="text-2xs text-ink-faint">x</span>')).toEqual([])
    expect(looks('<span className="text-xs uppercase">x</span>')).toEqual([])
  })

  it('a capsule: rounded-full with a border, on any element', () => {
    expect(looks('<span className="flex h-7 rounded-full border px-2.5">x</span>')).toEqual(['capsule'])
    expect(looks('<span className="size-2 rounded-full bg-ink">x</span>')).toEqual([])
  })

  it('does not count the shared components themselves at their call sites', () => {
    expect(looks('<Button variant="quiet" className="mt-2">x</Button>')).toEqual([])
    expect(looks('<TextInput size="sm" className="w-full" />')).toEqual([])
  })
})
