import { test, expect, type Page } from '@playwright/test'
import { setup, newSession, emitEvent } from './fixtures/control.js'
import { openSessionDialog } from './fixtures/new-session.js'

/**
 * The control loop's scenarios on reading older conversation back: pages, past conversations, compaction and external continuation. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

/**
 * Loading a past session — '+ -> pick a tool -> list of past conversations'.
 * If a conversation started in the terminal cannot be picked up here, this app is just
 * 'one more window'.
 */
async function seedPastSessions(
  page: Page,
  data: { supported: boolean; reason?: string; sessions: Record<string, unknown>[] },
  history: Record<string, { role: string; text: string }[]> = {},
) {
  await page.evaluate(
    ({ d, h }) => {
      const m = (window as any).__mock
      m.externalSessions = d
      for (const [id, msgs] of Object.entries(h)) m.externalHistory.set(id, msgs)
    },
    { d: data, h: history },
  )
}

test('Picking and loading a past conversation from the create-session modal', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(
    page,
    {
      supported: true,
      sessions: [
        {
          externalId: 'ext-1',
          tool: 'claude',
          title: "yesterday's refactor",
          updatedAt: Date.now() - 3600_000,
          createdAt: null,
          branch: 'main',
          imported: false,
        },
        {
          externalId: 'ext-2',
          tool: 'claude',
          title: 'track down the broken build',
          updatedAt: Date.now() - 86400_000,
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    },
    {
      'ext-1': [
        { role: 'user', text: 'split this module up' },
        { role: 'assistant', text: 'Split into three files' },
      ],
    },
  )

  // Set ext-2 up as already loaded (the mock decides by looking at actual sessions)
  await openSessionDialog(page, 'alpha')
  await page.getByTestId('past-ext-2').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  await openSessionDialog(page, 'alpha')
  // The default is 'new conversation' — loading must never be the default
  await expect(page.getByTestId('past-new')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('past-ext-1')).toContainText("yesterday's refactor")
  // Even for a tool (codex) whose title is 'the first message', recency must still be visible
  await expect(page.getByTestId('past-ext-1')).toContainText('last 1h ago')
  await expect(page.getByTestId('past-ext-2')).toContainText('Already open')

  await page.getByTestId('past-ext-1').click()
  // The button label itself states that resuming was chosen (Load ≠ Start) — a separate notice
  // was removed (#8)
  await expect(page.getByTestId('create-session-confirm')).toHaveText('Load')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // The past conversation is restored on screen
  await expect(page.getByTestId('chat-stream')).toContainText('split this module up')
  await expect(page.getByTestId('chat-stream')).toContainText('Split into three files')

  // Was the original to resume passed through to the host?
  const params = await page.evaluate(() => (window as any).__mock.lastCreateParams)
  expect(params.resumeExternalId).toBe('ext-1')
  expect(params.importHistory).toBe(true)

  // A loaded conversation is not drawn as unread (it has already been read)
  const sessionId = await page.evaluate(() => [...(window as any).__mock.sessions.keys()].at(-1))
  await expect(page.getByTestId(`session-row-${sessionId}`)).not.toHaveAttribute('data-unread', 'true')
})

test('An older tool version that cannot list past sessions does not block creating a new one', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(page, {
    supported: false,
    reason: 'The installed Codex does not support listing past sessions (update codex)',
    sessions: [],
  })

  await openSessionDialog(page, 'alpha')
  await expect(page.getByTestId('past-unsupported')).toContainText('update codex')
  // The reason is shown, but the path must stay open
  await expect(page.getByTestId('create-session-confirm')).toHaveText('Start')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill('start fresh anyway')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('chat-stream')).toContainText('start fresh anyway')
})

test('When there are no past conversations, it says so', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await seedPastSessions(page, { supported: true, sessions: [] })
  await openSessionDialog(page, 'alpha')
  await expect(page.getByTestId('past-empty')).toBeVisible()
})

test('Old conversation can still be read back through even after compaction', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // The store holds 250 lines while the screen holds only the most recent page (HISTORY_PAGE=100)
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const rows = Array.from({ length: 250 }, (_, i) => ({
      sessionId: sid,
      seq: i + 1,
      role: i % 2 ? 'assistant' : 'user',
      kind: 'text',
      payload: { text: `old message ${i + 1}` },
      ts: Date.now(),
    }))
    m.messages.set(sid, rows)
  }, id)
  // Simulates reopening the app and expanding that session (reading from the store with nothing
  // in memory)
  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)

  // The compaction point is marked in the conversation (the fact that the model forgot, but the
  // record remains)
  await page.evaluate((sid) => (window as any).__mock.emit({ type: 'compaction', sessionId: sid }), id)
  await expect(page.getByTestId('msg-mark')).toContainText('compacted')

  // Only the most recent page is on screen (with virtual scroll, what actually renders is fewer
  // still)
  const loaded = (sid: string) => (window as any).__store.getState().chat[sid].length
  expect(await page.evaluate(loaded, id)).toBe(101) // 100 + the compaction marker

  // Scrolling up loads more automatically, without a button. Once a page loads, position
  // correction pulls the view down from the top to preserve the reading spot (#61), so this
  // scrolls up again like a person would.
  await expect(async () => {
    await page.getByTestId('chat-stream').evaluate((el) => el.scrollTo({ top: 0 }))
    await expect(page.getByTestId('load-older')).toBeHidden({ timeout: 500 }) // There is nothing further back to load
  }).toPass()

  // Even a conversation the model forgot through compaction still remains in our own record
  expect(await page.evaluate(loaded, id)).toBe(251)
  const first = await page.evaluate((sid: string) => (window as any).__store.getState().chat[sid][0].text, id)
  expect(first).toBe('old message 1')
})

/*
 * Old conversation also loads by **clicking**, not just scrolling (dogfooding finding,
 * 2026-09-04: on the actual WKWebView, scrolling up did not load the older page — even in an
 * environment where the observer does not wake up, a manual way must remain).
 */
test('Older conversation also loads by clicking a button', async ({ page }) => {
  /*
   * Disable both automatic routes before history arrives. Clicking scrolls the button into
   * view, which otherwise loads a page itself and can hide a broken click handler. Automatic
   * loading is covered by the preceding test; this fallback must work without it.
   */
  await page.addInitScript(() => {
    ;(window as any).__observerDead = true
    window.addEventListener(
      'scroll',
      (e) => {
        if ((e.target as HTMLElement).dataset?.testid === 'chat-stream') e.stopPropagation()
      },
      { capture: true },
    )
    const Real = window.IntersectionObserver
    window.IntersectionObserver = class extends Real {
      constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
        super((entries, observer) => {
          if (!(window as any).__observerDead) cb(entries, observer)
        }, opts)
      }
    }
  })
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const rows = Array.from({ length: 250 }, (_, i) => ({
      sessionId: sid,
      seq: i + 1,
      role: i % 2 ? 'assistant' : 'user',
      kind: 'text',
      payload: { text: `old message ${i + 1}` },
      ts: Date.now(),
    }))
    m.messages.set(sid, rows)
  }, id)
  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)

  const loaded = (sid: string) => (window as any).__store.getState().chat[sid].length
  expect(await page.evaluate(loaded, id)).toBe(100)
  /*
   * The routes really are dead: at the top with the button on screen, nothing loads. Two frames
   * is long enough for both a scroll event and an observer callback to have been delivered.
   */
  await page.getByTestId('chat-stream').evaluate(async (el) => {
    el.scrollTo({ top: 0 })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  expect(await page.evaluate(loaded, id)).toBe(100)

  const button = page.getByTestId('load-older').getByRole('button')
  await button.click()
  await expect.poll(() => page.evaluate(loaded, id)).toBe(200)
  await expect(button).toBeEnabled()
  await button.click()
  await expect.poll(() => page.evaluate(loaded, id)).toBe(250)
  // Once everything is loaded, the button retires too
  await expect(page.getByTestId('load-older')).toBeHidden()
})

/*
 * A session whose events arrive before the screen does (#79). A session the host creates behind
 * the scenes (an agent the app asked for) can finish its work before the person ever opens it.
 * The transcript must still stand even when only viewed as a grid panel (there must be a path to
 * "older conversation"), and opening it for the first time must not show the same line twice —
 * measured (2026-09-25), the prompt and the Read/Write cards each showed up twice.
 */
test('A session whose events arrive first: an older-conversation path stands even in a grid panel, and opening it shows each line only once (#79)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // The host creates two sessions behind the scenes — the UI only learns of it via session_created
  const [g, f] = await page.evaluate(async (): Promise<[string, string]> => {
    const m = (window as any).__mock
    const project = Object.values((window as any).__store.getState().projects)[0] as {
      id: string
      path: string
    }
    const made: string[] = []
    for (let i = 0; i < 2; i++) {
      const info = await m.agents.createSession({ projectId: project.id, cwd: project.path, tool: 'claude' })
      m.emit({ type: 'session_created', sessionId: info.id, session: info })
      made.push(info.id)
    }
    return [made[0]!, made[1]!]
  })
  await page.evaluate(
    ({ g, f }) => {
      const m = (window as any).__mock
      // A session shown only in a panel: 250 stored lines, plus one reply that arrived before it was opened
      m.messages.set(
        g,
        Array.from({ length: 250 }, (_, i) => ({
          sessionId: g,
          seq: i + 1,
          role: 'user',
          kind: 'text',
          payload: { text: `entry ${i + 1}` },
          ts: Date.now(),
        })),
      )
      m.emit({ type: 'message_delta', sessionId: g, role: 'assistant', text: 'reply that arrived before opening' })
      // An agent the app asked for: request -> Read -> Write -> reply, all before the person ever opened it
      m.emit({
        type: 'user_message',
        sessionId: f,
        seq: 0,
        text: 'Make a note',
        fromApp: { appId: 'notes', projectId: null, name: 'Notes' },
      })
      m.emit({
        type: 'tool_call',
        sessionId: f,
        callId: 'r',
        summary: { tool: 'Read', title: 'Read note.md', paths: [] },
      })
      m.emit({ type: 'tool_result', sessionId: f, callId: 'r', ok: true, summary: 'empty' })
      m.emit({
        type: 'tool_call',
        sessionId: f,
        callId: 'w',
        summary: { tool: 'Write', title: 'Write note.md', paths: [] },
      })
      m.emit({ type: 'tool_result', sessionId: f, callId: 'w', ok: true, summary: 'written' })
      m.emit({ type: 'message_delta', sessionId: f, role: 'assistant', text: 'Noted.' })
      m.emit({ type: 'turn_complete', sessionId: f })
    },
    { g, f },
  )

  // View only through a grid panel — never focus it
  await page.evaluate((ids) => (window as any).__store.getState().setGridPanels(ids.map((sessionId: string) => ({ kind: 'session', sessionId }))), [a, g])
  await page.getByTestId('grid-button').click()
  const cell = page.getByTestId(`grid-panel-${g}`)
  await expect(cell.getByTestId('chat-stream')).toContainText('reply that arrived before opening')
  await expect(cell.getByTestId('load-older')).toBeVisible()
  // Reading all the way back, every stored line shows exactly once and in order
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const store = (window as any).__store
        await store.getState().loadOlder(id)
        return store.getState().history[id].more
      }, g),
    )
    .toBe(false)
  const texts = await page.evaluate(
    (id) => (window as any).__store.getState().chat[id].map((c: { text: string }) => c.text),
    g,
  )
  expect(texts).toEqual([...Array.from({ length: 250 }, (_, i) => `entry ${i + 1}`), 'reply that arrived before opening'])

  // Open the app-requested agent's session for the first time from the sidebar
  await page.getByTestId(`session-row-${f}`).click()
  const stream = page.getByTestId('chat-stream')
  await expect(stream).toContainText('Noted.')
  await expect
    .poll(() => page.evaluate((id) => (window as any).__store.getState().history[id], f))
    .toMatchObject({ loading: false, more: false })
  await expect(page.getByTestId('load-older')).toBeHidden()
  await expect(stream.getByTestId('msg-user').filter({ hasText: 'Make a note' })).toHaveCount(1)
  await expect(stream.getByTestId('tool-card').filter({ hasText: 'Read note.md' })).toHaveCount(1)
  await expect(stream.getByTestId('tool-card').filter({ hasText: 'Write note.md' })).toHaveCount(1)
})

/**
 * The conversation used to render garbled (4th round of dogfooding).
 * The stored transcript's seq and the live items' seq were counted separately, so React keys
 * collided, and virtual scroll drew the colliding items on top of each other, running the text
 * together.
 */
test('New messages added to a session loaded from history do not collide with existing item numbers', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Open a fresh session whose store already has a transcript with seq 1..5
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const store = (window as any).__store
    m.messages.set(
      sid,
      Array.from({ length: 5 }, (_, i) => ({
        sessionId: sid,
        seq: i + 1,
        role: i % 2 ? 'assistant' : 'user',
        kind: 'text',
        payload: { text: `entry ${i + 1}` },
        ts: Date.now(),
      })),
    )
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)

  // A live conversation continues on top of that (seq used to restart from 1 here)
  await page.getByTestId('prompt-input').fill('a fresh message')
  await page.getByTestId('send').click()
  await page.evaluate(
    (sid) =>
      (window as any).__mock.emit({
        type: 'message_delta',
        sessionId: sid,
        role: 'assistant',
        text: 'a new reply',
      }),
    id,
  )

  const seqs = await page.evaluate(
    (sid) => (window as any).__store.getState().chat[sid].map((c: { seq: number }) => c.seq),
    id,
  )
  expect(new Set(seqs).size).toBe(seqs.length)

  // With no collision, the old record and the new message each show in their own place
  await expect(page.getByTestId('chat-stream')).toContainText('entry 5')
  await expect(page.getByTestId('chat-stream')).toContainText('a fresh message')
})

test('Picking an already-open conversation again navigates to that session instead of creating a new one', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.externalSessions = {
      supported: true,
      sessions: [
        {
          externalId: 'ext-1',
          tool: 'claude',
          title: "yesterday's work",
          updatedAt: Date.now(),
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    }
    m.externalHistory.set('ext-1', [{ role: 'user', text: "yesterday's work" }])
  })

  await openSessionDialog(page, 'alpha')
  await page.getByTestId('past-ext-1').click()
  await page.getByTestId('create-session-confirm').click()
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Opening it again shows "Already open", and clicking it navigates instead of creating
  await openSessionDialog(page, 'alpha')
  await expect(page.getByTestId('past-ext-1')).toContainText('Already open')
  await page.getByTestId('past-ext-1').click()

  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  expect(await page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(id)
  // No extra session was created
  expect(await page.evaluate(() => (window as any).__mock.sessions.size)).toBe(1)
})

test('Two sessions cannot open the same conversation (blocked here before the tool would refuse it)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.externalSessions = {
      supported: true,
      sessions: [
        {
          externalId: 'ext-1',
          tool: 'claude',
          title: 'the only conversation',
          updatedAt: Date.now(),
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    }
    m.externalHistory.set('ext-1', [{ role: 'user', text: 'the only conversation' }])
  })

  await openSessionDialog(page, 'alpha')
  await page.getByTestId('past-ext-1').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // Opening it again shows "Already open" and navigates to that session instead of creating a new one
  await openSessionDialog(page, 'alpha')
  await expect(page.getByTestId('past-ext-1')).toContainText('Already open')
  expect(await page.evaluate(() => (window as any).__mock.sessions.size)).toBe(1)
})

/**
 * Loading a long conversation must show **the bottom (most recent) part**.
 * Staying at the top only shows old messages, which reads as "the latest was not fetched"
 * (pointed out during dogfooding).
 */
test('A loaded conversation shows the most recent messages first', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.externalSessions = {
      supported: true,
      sessions: [
        {
          externalId: 'ext-long',
          tool: 'claude',
          title: 'a very old first question',
          updatedAt: Date.now(),
          createdAt: null,
          branch: null,
          imported: false,
          importedAs: null,
        },
      ],
    }
    // A 200-line long conversation — the last one is the most recent
    m.externalHistory.set(
      'ext-long',
      Array.from({ length: 200 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        text: i === 199 ? 'the most recent message' : `old message ${i + 1}`,
      })),
    )
  })

  await openSessionDialog(page, 'alpha')
  await page.getByTestId('past-ext-long').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // The bottom (most recent) must be visible on screen
  await expect(page.getByTestId('chat-stream')).toContainText('the most recent message')

  // The list lands on the bottom after its rows are measured; wait for that, do not read the position once
  const stream = page.getByTestId('chat-stream')
  await expect(stream).not.toHaveAttribute('data-settling', /.*/)
  await expect
    .poll(() => stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80))
    .toBe(true)
})

test('A conversation continued externally shows up on screen once it comes back', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Simulate the host catching up and writing it into the store
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    const rows = m.messages.get(sid) ?? []
    m.messages.set(sid, [
      ...rows,
      {
        sessionId: sid,
        seq: rows.length + 1,
        role: 'user',
        kind: 'text',
        payload: { text: 'said in the terminal' },
        ts: Date.now(),
      },
      {
        sessionId: sid,
        seq: rows.length + 2,
        role: 'assistant',
        kind: 'text',
        payload: { text: 'reply from the terminal' },
        ts: Date.now(),
      },
    ])
    m.emit({ type: 'history_synced', sessionId: sid, added: 2 })
  }, id)

  // Receiving the event makes the screen re-read the store
  await expect(page.getByTestId('chat-stream')).toContainText('said in the terminal')
  await expect(page.getByTestId('chat-stream')).toContainText('reply from the terminal')
})

/**
 * A failed compaction used to be swallowed entirely (measured: "Not enough messages to
 * compact."). The context stays unchanged, and the screen must not look as if nothing happened.
 */
test('A failed compaction leaves that fact visible in the conversation', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Start')

  await emitEvent(page, 0, { type: 'compaction', failed: true, reason: 'Not enough messages to compact.' })
  await expect(page.getByText('Compaction failed — Not enough messages to compact.')).toBeVisible()
})
