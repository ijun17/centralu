import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../store/store.js'

/*
 * The handoff dialog as it first opens (#1477). renderToStaticMarkup draws the initial state, which is what the defaults
 * are: `useStore` reads a seeded state (as in SessionListRow.test.tsx) and the modal's portal is replaced by its children.
 */
const tools = [
  { name: 'claude', label: 'Claude Code', mark: 'C', install: '' },
  { name: 'codex', label: 'Codex', mark: 'X', install: '' },
]
vi.mock('../../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), tools } as unknown as AppState)
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})
vi.mock('../../../components/Modal.jsx', () => ({ Modal: ({ children }: { children: ReactNode }) => <div>{children}</div> }))

const { ConfirmHandoff, KeepNote } = await import('./ConfirmHandoff.jsx')

const render = (over: Partial<Parameters<typeof ConfirmHandoff>[0]> = {}) =>
  renderToStaticMarkup(
    <ConfirmHandoff name="Fix login" tool="claude" dead={false} blocked={null} backgroundTasks={0} working={false} onConfirm={() => {}} onCancel={() => {}} {...over} />,
  )

/** The archive box's own tag, so a `checked` elsewhere cannot pass for it */
const archiveBox = (html: string) => /<input[^>]*type="checkbox"[^>]*>/.exec(html)![0]

describe('the handoff dialog defaults (#1477)', () => {
  it('starts with the archive box on, and says the original is archived', () => {
    const html = render()
    expect(archiveBox(html)).toContain('checked')
    expect(html).toContain('data-testid="handoff-warning"')
    expect(html).toContain('this session is archived')
    expect(html).not.toContain('handoff-keep-note')
  })

  it('starts on for a dead session too, with the note from the record', () => {
    const html = render({ dead: true })
    expect(archiveBox(html)).toContain('checked')
    expect(html).toContain('data-testid="handoff-warning"')
  })

  it('says nothing of the kept original while it is archived, and what archiving stops when work is running', () => {
    expect(render({ backgroundTasks: 2 })).not.toContain('handoff-background-note')
    expect(render()).not.toContain('handoff-stops-note')
    expect(render({ working: true })).toContain('It is working now: the note holds what is stored so far, and archiving ends its turn.')
    expect(render({ backgroundTasks: 1 })).toContain('Archiving stops it and its 1 background task.')
    expect(render({ working: true, backgroundTasks: 2 })).toContain('ends its turn, and its 2 background tasks.')
  })
})

describe('the note for a kept original (#1477)', () => {
  it('says nothing more when no background task runs', () => {
    const html = renderToStaticMarkup(<KeepNote backgroundTasks={0} />)
    expect(html).toContain('This session stays')
    expect(html).not.toContain('handoff-background-note')
  })

  it('counts the running background tasks and says they wake the session', () => {
    expect(renderToStaticMarkup(<KeepNote backgroundTasks={1} />)).toContain('It still has 1 background task running; when it ends, this session wakes for a turn.')
    expect(renderToStaticMarkup(<KeepNote backgroundTasks={3} />)).toContain('It still has 3 background tasks running; when one ends, this session wakes for a turn.')
  })
})
