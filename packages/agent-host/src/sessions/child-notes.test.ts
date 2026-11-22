/**
 * A note for a session the caller started (#2493): `mail` with `kind: "note"` to its own child is a message that needs no reply, given quietly at the
 * child's next turn: no task, no turn of its own, no report. Refused as new work is (a child above its caller); to any other session it is plain mail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionPreset } from '@cc/protocol'
import { crossWorld, type CrossWorld, sendNote } from './cross-project.test-helpers.js'
import { wireHostMail } from './host-mail.test-helpers.js'

describe('a note for a session the caller started (#2493)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
    vi.restoreAllMocks()
  })
  const session = async (permissionPreset: PermissionPreset = 'auto', askedBy?: string) =>
    (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset, askedBy })).id

  it('is a quiet message that needs no reply, not a task; refused for a child above its caller; plain mail to a session it did not start', async () => {
    wireHostMail(w.mgr, w.store)
    const caller = await session('normal')
    const child = await session('normal', caller)
    const note = await sendNote(w.mgr, caller, child, 'FYI: the standing rule is to rebase before review')
    if (!note?.ok) throw new Error(`no note: ${JSON.stringify(note)}`)
    const m = w.store.mailbox.message(note.messageId)
    expect(m).toMatchObject({ kind: 'message', needsReply: false, facts: { quiet: true } })
    const [row] = w.store.mailbox.recipients(note.messageId)
    expect(row?.recipient.endsWith(child)).toBe(true)
    // Not work: nothing waits for a report of it
    expect(w.store.mailbox.watchedTo(row?.recipient ?? '')).toEqual([])
    expect(await sendNote(w.mgr, caller, await session('auto', caller), 'x')).toMatchObject({ ok: false, error: expect.stringContaining('more permissions') })
    expect(await sendNote(w.mgr, caller, await session('normal'), 'x')).toBeNull()
  })
})
