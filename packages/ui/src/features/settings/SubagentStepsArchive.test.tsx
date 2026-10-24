import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SubagentStepsHeld } from '@cc/protocol'
import { SubagentStepsHeldList, TrashedSubagentStepsRow, stepsTake } from './SubagentStepsArchive.jsx'

/**
 * #418: Settings → Archive says what each session's subagent steps take and moves them to the session archive without the session;
 * in the session archive they are a row of their own.
 */

const held = (sessionId: string, bytes: number, over: Partial<SubagentStepsHeld> = {}): SubagentStepsHeld => ({
  sessionId, name: `Session ${sessionId}`, tool: 'claude', project: { id: 'p1', name: 'alpha' }, runs: 2, steps: 1234, bytes, ...over,
})
const idle = () => ({ busy: false, error: null })
const noop = () => {}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const testIds = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!)

describe('what a session’s subagent steps take', () => {
  it('reads as runs, steps and size', () => {
    expect(stepsTake({ runs: 1, steps: 1, bytes: 512 })).toBe('1 run · 1 step · 512 B')
    // Counts through the shared formatter, as every other count on screen
    expect(stepsTake({ runs: 2, steps: 20689, bytes: 46 * 1024 * 1024 })).toMatch(/^2 runs · 20\.7k steps · 46(\.0)? MB$/)
  })

  it('lists each session largest first in the conversation’s card shape, each with a button to move them', () => {
    const html = renderToStaticMarkup(
      <SubagentStepsHeldList sessions={[held('small', 100), held('big', 9000, { project: null })]} error={null} onRetry={noop} row={idle} onMove={noop} />,
    )
    expect(testIds(html).filter((id) => id.startsWith('subagent-steps-held-'))).toEqual([
      'subagent-steps-held-list', 'subagent-steps-held-big', 'subagent-steps-held-small',
    ])
    expect(html).toMatch(/class="[^"]*rounded-bubble[^"]*" data-testid="subagent-steps-held-list"/)
    expect(html).toMatch(/<button[^>]*data-testid="subagent-steps-move-big"/)
    expect(text(html)).toContain('Session big No project Archive 2 runs · 1.2k steps')
  })

  it('moves at once with no question, and says why a move was refused, on the row it is about (#1512)', () => {
    const html = renderToStaticMarkup(
      <SubagentStepsHeldList
        sessions={[held('a', 10)]}
        error={null}
        onRetry={noop}
        row={() => ({ busy: false, error: 'Session not found: a' })}
        onMove={noop}
      />,
    )
    expect(testIds(html)).toEqual(expect.arrayContaining(['subagent-steps-error-a', 'subagent-steps-move-a']))
    expect(testIds(html)).not.toContain('subagent-steps-confirm')
    expect(text(html)).not.toContain('Move the subagent steps of')
  })

  // #418 review: a machine not read left the list saying no session keeps any (#841's rule, ux-writing §1.5)
  it('names each machine it could not read, and never says no session keeps any while one was not read', () => {
    const unreached = [{ machineId: 'm1', name: 'Box' }]
    const none = renderToStaticMarkup(<SubagentStepsHeldList sessions={[]} unreached={unreached} error={null} onRetry={noop} row={idle} onMove={noop} />)
    expect(testIds(none)).not.toContain('subagent-steps-held-empty')
    expect(text(none)).toContain('Box: its sessions could not be read just now, so their subagent steps are not listed.')
    const some = renderToStaticMarkup(<SubagentStepsHeldList sessions={[held('a', 10)]} unreached={unreached} error={null} onRetry={noop} row={idle} onMove={noop} />)
    expect(testIds(some)).toEqual(expect.arrayContaining(['subagent-steps-held-a', 'subagent-steps-unreached-m1']))
  })

  it('says when no session keeps any, and when they could not be read', () => {
    const none = renderToStaticMarkup(<SubagentStepsHeldList sessions={[]} error={null} onRetry={noop} row={idle} onMove={noop} />)
    expect(testIds(none)).toContain('subagent-steps-held-empty')
    const failed = renderToStaticMarkup(<SubagentStepsHeldList sessions={null} error="host went away" onRetry={noop} row={idle} onMove={noop} />)
    expect(text(failed)).toContain('Could not read what subagent steps take: host went away')
    expect(testIds(failed)).not.toContain('subagent-steps-held-empty')
  })
})

describe('a session’s subagent steps in the session archive', () => {
  it('is a row saying what they take and that the session stays, with Restore and Delete for good', () => {
    const html = renderToStaticMarkup(
      <ul>
        <TrashedSubagentStepsRow entry={{ ...held('a', 2048), deletedAt: 0 }} busy={false} confirming={true} error={null} onRestore={noop} onAskPurge={noop} onPurge={noop} onCancel={noop} />
      </ul>,
    )
    expect(text(html)).toContain('Subagent steps of Session a alpha')
    expect(text(html)).toContain('2 runs · 1.2k steps · 2 KB · the session stays')
    expect(testIds(html)).toEqual(expect.arrayContaining(['trash-steps-restore-a', 'trash-steps-purge-a', 'trash-confirm-yes']))
    expect(text(html)).toContain('Delete the subagent steps of “Session a” for good? 1.2k steps leave this computer; the session and its conversation stay.')
  })
})
