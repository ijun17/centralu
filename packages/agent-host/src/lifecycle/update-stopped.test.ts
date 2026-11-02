import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import { isUpdateContinueNote, UPDATE_CONTINUE_TEXT } from '../adapters/input-receipts.js'
import { memoryUpdateFolder } from './update-resume.test-helpers.js'
import { parseUpdateResume, recordUpdateCut, UpdateResumeLists } from './update-resume.js'
import { readStopped, stoppedAtUpdate, updateNote } from './update-stopped.js'

const session = (o: Partial<SessionInfo> & { id: string }): SessionInfo => ({ live: true, backgroundTasks: [], pendingApproval: null, pendingQuestions: [], ...o }) as SessionInfo
const task = (id: string, o: Partial<SessionInfo['backgroundTasks'][number]> = {}): SessionInfo['backgroundTasks'][number] => ({ id, kind: 'shell', description: `task ${id}`, status: 'running', ...o })

describe("what an update's stop lists beside the turns (#1902)", () => {
  const inputs: Record<string, unknown> = { 'a:c1': { command: '  npm run dev  ' }, 'a:c2': { prompt: 'no command here' } }
  const list = (sessions: SessionInfo[]) => stoppedAtUpdate(sessions, (id, call) => inputs[`${id}:${call}`])

  it('lists the running tasks of a live session with the command of the call that started each; ambient ones, ended ones and sessions without a process are left out', () => {
    const out = list([
      session({ id: 'a', backgroundTasks: [task('t1', { parentCallId: 'c1' }), task('t2', { parentCallId: 'c2', kind: 'agent' }), task('t3', { ambient: true }), task('t4', { status: 'completed' }), task('t5', { timer: true })] }),
      session({ id: 'b', live: false, backgroundTasks: [task('t6')] }),
      session({ id: 'c' }),
    ])
    expect(out).toEqual([
      {
        id: 'a',
        approvals: false,
        questions: [],
        tasks: [
          { kind: 'shell', description: 'task t1', command: 'npm run dev' },
          { kind: 'agent', description: 'task t2' },
          { kind: 'shell', description: 'task t5' },
        ],
      },
    ])
  })

  it('lists the cards that wait for the person, and clips what could be huge', () => {
    const long = 'x'.repeat(5000)
    const out = list([
      session({
        id: 'q',
        pendingApproval: { requestId: 'r', detail: { kind: 'command', command: 'rm -rf x', cwd: '/' } },
        pendingQuestions: [{ requestId: 'q1', questions: [{ question: long, header: '', options: [], multiSelect: false }] }],
        backgroundTasks: [task('t', { description: long })],
      }),
    ])
    expect(out[0]!.approvals).toBe(true)
    expect(out[0]!.questions[0]!.length).toBeLessThan(600)
    expect(out[0]!.tasks[0]!.description.length).toBeLessThan(600)
  })

  it('is read back whole from the list, and an entry another build wrote in another shape is skipped, not guessed', () => {
    const entry = { id: 's1', seq: 3, tasks: [{ kind: 'shell', description: 'd', command: 'c' }, { kind: 'surprise', description: 'd' }, { description: 'no kind' }], approvals: true, questions: ['q', 4] }
    expect(readStopped(entry)).toEqual({ id: 's1', seq: 3, tasks: [{ kind: 'shell', description: 'd', command: 'c' }], approvals: true, questions: ['q'] })
    expect(readStopped({ id: 's1', seq: -1 })).toBeNull()
    // Only a true is an approval that waited
    expect(readStopped({ id: 's1', seq: 3, approvals: 1 })).toMatchObject({ approvals: false })
    expect(readStopped('s1')).toBeNull()
    const text = JSON.stringify({ v: 1, turns: [{ id: 'a', seq: 1 }], stopped: [entry, { id: '../bad id', seq: 1 }] })
    expect(parseUpdateResume(text)).toMatchObject({ turns: [{ id: 'a', seq: 1 }], stopped: [{ id: 's1' }] })
    // A list from before this (turns only) still reads
    expect(parseUpdateResume(JSON.stringify({ v: 1, turns: [{ id: 'a', seq: 1 }] }))).toEqual({ turns: [{ id: 'a', seq: 1 }], stopped: [], ended: { terminals: [], runs: [] } })
  })

  it('a stop that ended only tasks still writes a list; a session is taken by its mark, and the list goes once all it names are dealt with', () => {
    const f = memoryUpdateFolder()
    recordUpdateCut(f, [{ id: 'a', seq: 2 }], [{ id: 'a', seq: 2, tasks: [], approvals: true, questions: [] }, { id: 'b', seq: 5, tasks: [{ kind: 'shell', description: 'd' }], approvals: false, questions: [] }])
    const lists = new UpdateResumeLists(f)
    expect([...lists.ids()].sort()).toEqual(['a', 'b'])
    expect(lists.stoppedOf('b', 5)).toMatchObject({ id: 'b' })
    expect(lists.stoppedOf('b', 6)).toBeNull()
    lists.done('a')
    expect(f.files.size).toBe(1)
    lists.done('b')
    expect(f.files.size).toBe(0)
    const only = memoryUpdateFolder()
    recordUpdateCut(only, [], [{ id: 'z', seq: 1, tasks: [{ kind: 'shell', description: 'd' }], approvals: false, questions: [] }])
    expect(only.files.size).toBe(1)
    const none = memoryUpdateFolder()
    recordUpdateCut(none, [], [])
    expect(none.files.size).toBe(0)
  })
})

describe("Centralu's note after an update (#1902)", () => {
  const stopped = { id: 's', seq: 1, tasks: [{ kind: 'shell' as const, description: 'Dev server', command: 'npm run dev\nrm -rf x' }, { kind: 'agent' as const, description: 'Review' }], approvals: false, questions: [] }

  it('a cut turn keeps the sentence the Continue always had; a session at rest is told only what stopped', () => {
    expect(updateNote(true, null)).toBe(UPDATE_CONTINUE_TEXT)
    const rest = updateNote(false, stopped)
    expect(rest).toContain('Your turn had ended, but the update stopped the background work your session was running.')
    expect(rest).not.toContain('Continue where you stopped')
    // A command with a newline stays on its line: it cannot pass itself off as the note's own text
    expect(rest).toContain('- shell command: "npm run dev\\nrm -rf x" (Dev server)')
    expect(rest).toContain('- background agent: Review')
  })

  it('names the cards the update closed and says the person did not refuse them', () => {
    const note = updateNote(true, { ...stopped, tasks: [], approvals: true, questions: ['Sushi or ramen?'] })
    expect(note.startsWith(UPDATE_CONTINUE_TEXT)).toBe(true)
    expect(note).toContain('The update closed the permission card of your pending tool call. The person did not refuse it, whatever its result says.')
    expect(note).toContain('Ask again if you still need the answer:\n- "Sushi or ramen?"')
    expect(note).not.toContain('background tasks')
  })

  it("every form of it reads back as Centralu's own, never as a message of the person (the catch-up anchors after it)", () => {
    for (const text of [updateNote(true, null), updateNote(true, stopped), updateNote(false, stopped)]) expect(isUpdateContinueNote(text)).toBe(true)
    expect(isUpdateContinueNote('Centralu on this machine was updated')).toBe(false)
  })
})
