import { test, expect } from '@playwright/test'
import { setup, newSession, emitEvent } from './fixtures/control.js'

/**
 * The control loop's scenarios on how an agent's output is drawn: markdown, tool cards, reasoning, plans, images and waiting looks. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

test('Creating a session renders the conversation stream (T5-3)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Hello')
  await expect(page.getByTestId('msg-user')).toContainText('Hello')

  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'Yes, ' })
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'nice to meet you' })
  await expect(page.getByTestId('msg-assistant')).toContainText('Yes, nice to meet you')
})

/*
 * Two replies with no human message between them are two separate chunks (#77). When a
 * background task finished and a new turn started, it used to butt up against the previous
 * reply with no space, showing as "...still running.All six reviews are in." This must look
 * the same whether received live or redrawn from the transcript.
 */
test('Two replies with no human message between them render as two chunks — live and from the transcript alike (#77)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Run the review')
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'One review ' })
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'is still running.' })
  // The turn ends, and a new turn starts with no human message
  await emitEvent(page, 0, { type: 'turn_complete' })
  await emitEvent(page, 0, { type: 'message_delta', role: 'assistant', text: 'All six reviews are in.' })
  await expect(page.getByTestId('msg-assistant')).toHaveText([
    'One review is still running.',
    'All six reviews are in.',
  ])

  // Open a session where two adjacent replies are stored at the end of the transcript — the shape
  // produced when history import writes one row per reply
  const id = await page.evaluate(async () => {
    const m = (window as any).__mock
    const project = Object.values((window as any).__store.getState().projects)[0] as {
      id: string
      path: string
    }
    const info = await m.agents.createSession({ projectId: project.id, cwd: project.path, tool: 'claude' })
    m.emit({ type: 'session_created', sessionId: info.id, session: info })
    const row = (seq: number, role: string, text: string) => ({
      sessionId: info.id,
      seq,
      role,
      kind: 'text',
      payload: { text },
      ts: Date.now(),
    })
    m.messages.set(info.id, [
      row(1, 'user', 'Imported question'),
      row(2, 'assistant', 'First imported reply.'),
      row(3, 'assistant', 'Second imported reply.'),
    ])
    return info.id as string
  })
  await page.evaluate((sid) => (window as any).__store.getState().focusSession(sid), id)
  await expect(page.getByTestId('msg-user')).toHaveText('Imported question')
  await expect(page.getByTestId('msg-assistant')).toHaveText([
    'First imported reply.',
    'Second imported reply.',
  ])
})

test('Tool card: read-only calls are collapsed, mutating calls are expanded (T5-3)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'x')
  await emitEvent(page, 0, {
    type: 'tool_call',
    callId: 'c1',
    summary: { tool: 'Read', title: 'Read: a.ts', paths: [] },
  })
  await emitEvent(page, 0, {
    type: 'tool_result',
    callId: 'c1',
    ok: true,
    summary: `line one\nline two\nline three\nline four\n200 lines of file content`,
  })
  // Read-only tools start collapsed — only a preview shows, the rest stays hidden
  await expect(page.getByTestId('tool-card')).toBeVisible()
  await expect(page.getByTestId('tool-card-output')).toContainText('line one')
  await expect(page.getByTestId('tool-card-output')).not.toContainText('200 lines of file content')
  await page.getByTestId('tool-card-toggle').click()
  await expect(page.getByTestId('tool-card-output')).toContainText('200 lines of file content')
})

test('Agent replies render as markdown (M2.5)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await emitEvent(page, 0, {
    type: 'message_delta',
    role: 'assistant',
    text: '## Result\n\n- **Important** item\n- a `code` snippet\n\n```ts\nconst x = 1\n```',
  })
  const md = page.getByTestId('markdown')
  await expect(md.locator('h2')).toContainText('Result')
  await expect(md.locator('strong')).toContainText('Important')
  await expect(md.locator('pre code')).toContainText('const x = 1')
})

test('Tool cards collapse and expand without an inner scrollbar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.emit({
      type: 'tool_call',
      sessionId: sid,
      callId: 'c1',
      summary: { tool: 'Bash', title: 'pnpm test', paths: [] },
    })
    m.emit({
      type: 'tool_result',
      sessionId: sid,
      callId: 'c1',
      ok: true,
      summary: Array.from({ length: 40 }, (_, i) => `output ${i + 1}`).join('\n'),
    })
  }, id)

  const output = page.getByTestId('tool-card-output')
  await expect(output).toBeVisible()

  // Read-only tools start collapsed, showing only a preview
  await expect(output).toContainText('output 1')
  await expect(output).not.toContainText('output 40')
  await expect(page.getByTestId('tool-card-more')).toContainText('37 more lines')

  // There is no inner scroller to intercept the conversation's scroll
  const scrollable = await output.evaluate((el) => {
    const s = getComputedStyle(el)
    return s.overflowY === 'auto' || s.overflowY === 'scroll' || el.scrollHeight > el.clientHeight + 1
  })
  expect(scrollable).toBe(false)

  await page.getByTestId('tool-card-more').click()
  await expect(output).toContainText('output 40')
  const stillScrollable = await output.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(stillScrollable).toBe(false)
})

/**
 * The preview counts by **visible lines** (pointed out by the person, 2026-09-12).
 *
 * A single blob of JSON with no newlines (a resource-upload response) counted as 1 line by
 * counting newlines, so nothing got truncated, and on screen it wrapped into dozens of lines,
 * with the "collapsed" card covering the entire conversation.
 */
test('A single blob with no newlines still stops at three lines when collapsed', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.emit({
      type: 'tool_call',
      sessionId: sid,
      callId: 'c1',
      summary: { tool: 'mcp__resource__upload', title: 'upload', paths: [] },
    })
    // A response with not a single newline — logically 1 line, dozens on screen
    const blob = JSON.stringify({
      resourceList: Array.from({ length: 30 }, (_, i) => ({
        ruid: `e0665a7978ed49539afab9544eec53${i}`,
        name: 'msa_532_5341503_icon_icon_c09af380e8',
        size: 1013,
      })),
    })
    m.emit({ type: 'tool_result', sessionId: sid, callId: 'c1', ok: true, summary: blob })
  }, id)

  const output = page.getByTestId('tool-card-output')
  await expect(output).toBeVisible()

  const collapsed = await output.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(el).lineHeight),
    full: el.scrollHeight,
  }))
  // Never taller than three lines (1px accounts for rounding)
  expect(collapsed.height).toBeLessThanOrEqual(collapsed.line * 3 + 1)
  // Also record that it was far taller before collapsing — proof the cap is actually doing something
  expect(collapsed.full).toBeGreaterThan(collapsed.line * 10)

  // Line counting cannot say "how many more lines" (hidden === 0) — it must still say there is more to expand
  await expect(page.getByTestId('tool-card-more')).toContainText('Show all')

  await page.getByTestId('tool-card-more').click()
  const opened = await output.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    scrollable: el.scrollHeight > el.clientHeight + 1,
  }))
  expect(opened.height).toBeGreaterThan(collapsed.line * 10)
  expect(opened.scrollable).toBe(false)
})

test('A long URL or path does not push the conversation panel sideways', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const long = `https://example.com/${'very-long-segment'.repeat(20)}`
  await page.getByTestId('prompt-input').fill(long)
  await page.getByTestId('send').click()
  await page.evaluate(
    ({ sid, text }) =>
      (window as any).__mock.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text }),
    { sid: id, text: `Note: ${long}` },
  )
  await expect(page.getByTestId('msg-assistant').last()).toBeVisible()

  // The conversation panel must not scroll horizontally
  const stream = await page.getByTestId('chat-stream').evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(stream.scroll).toBeLessThanOrEqual(stream.client + 1)

  // The same goes for the whole window
  const page2 = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(page2.scroll).toBeLessThanOrEqual(page2.client)
})

/**
 * "There is no loading indicator right now, so I cannot tell if it is working or stuck"
 * (dogfooding finding). There must be a live indicator from the moment something is sent until
 * the reply arrives, and it must be possible to stop from there.
 */
test('An indicator shows while waiting for a response, with a way to stop from there', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill('something that takes a while')
  await page.getByTestId('prompt-input').press('Enter')

  await page.getByTestId('prompt-input').fill('do something that takes forever')
  await page.getByTestId('send').click()

  // Appears the instant it is sent — it does not wait for the host's response
  await expect(page.getByTestId('activity-row')).toBeVisible()

  await page.getByTestId('activity-interrupt').click()
  await expect(page.getByTestId('activity-row')).toBeHidden()
})

/**
 * "The UI looks identical during compaction and while waiting for a response, so I cannot tell
 * whether it is replying or just taking a while to compact" (dogfooding finding).
 *
 * Measured with a probe, one manual compaction took 39 seconds. If the screen does not differ
 * from "waiting for response" by even one character during that time, the person waiting has no
 * way to judge what is happening.
 */
test('Compacting looks different from waiting for a response', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Start')

  await page.getByTestId('prompt-input').fill('clean up the conversation')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('activity-label')).toHaveText('Waiting for response')

  await emitEvent(page, 0, { type: 'activity', activity: 'compacting' })
  await expect(page.getByTestId('activity-label')).toHaveText('Compacting context')

  // Once compaction ends, it returns to ordinary waiting — the state was working the whole time
  await emitEvent(page, 0, { type: 'activity', activity: null })
  await expect(page.getByTestId('activity-label')).toHaveText('Waiting for response')
})

// Codex reconnecting on its own (#168) is a wait of several attempts, not a failure — it says so while it lasts
test('Reconnecting looks different from waiting for a response, and leaves no failure line', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Start')

  await page.getByTestId('prompt-input').fill('say hi')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('activity-label')).toHaveText('Waiting for response')

  await emitEvent(page, 0, { type: 'activity', activity: 'retrying' })
  await expect(page.getByTestId('activity-label')).toHaveText('Reconnecting')

  await emitEvent(page, 0, { type: 'activity', activity: null })
  await expect(page.getByTestId('activity-label')).toHaveText('Waiting for response')
  await expect(page.getByText('could not finish this turn')).toHaveCount(0)
})

/*
 * A lock found after a slow background resume had already handed the session back (#168, item 5).
 * It arrives as an event, not as the wake result — the fork offer has to appear all the same.
 */
test('A lock error that arrives after the session was handed back offers Continue in a fork', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'Start')
  await expect(page.getByTestId('dormant-note')).toBeHidden()

  await emitEvent(page, 0, {
    type: 'error',
    error: { code: 'conversation_locked', message: 'This conversation is already open elsewhere', retryable: true },
  })
  await expect(page.getByTestId('dormant-note')).toContainText('already open elsewhere')
  await expect(page.getByTestId('dormant-fork')).toBeVisible()
  await expect(page.getByText('Could not open this conversation — This conversation is already open elsewhere')).toBeVisible()
})

/**
 * The elapsed count used to restart whenever the row was remounted (issue #23): a turn
 * three minutes old read as if it had just begun. The lie ran in the worst direction —
 * the longer the wait, the more it understated it.
 *
 * The count is derived from a start instant on the store now, so this ages the turn by
 * moving that instant rather than by actually waiting. Switching to the grid and back tears
 * the row down and builds it again, which is precisely what used to reset it.
 */
test('the elapsed count survives a view change — the start instant is what is stored', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'start')

  await page.getByTestId('prompt-input').fill('something slow')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('activity-row')).toBeVisible()

  const id = await page.evaluate(() => {
    const store = (window as any).__store
    const sessionId = store.getState().focusedSessionId as string
    // Three minutes and five seconds ago. Nothing else feeds the count
    store.setState({ workingSince: { [sessionId]: Date.now() - 185_000 } })
    return sessionId
  })
  await expect(page.getByTestId('activity-elapsed')).toHaveText(/^3m/)

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId('activity-row')).toBeHidden()

  // Back to the focus view: a brand new row, still counting from the same instant
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('activity-row')).toBeVisible()
  await expect(page.getByTestId('activity-elapsed')).toHaveText(/^3m/)
})

/**
 * A single session marker states both the tool and the state.
 * A separate dot right next to the marker would overlap in reading and blur both.
 */
test('A working session has the answering look on its marker', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  const mark = page.getByTestId('tool-mark-claude')
  await expect(mark).toHaveAttribute('data-state', /idle|waiting_input|working/)

  await page.getByTestId('prompt-input').fill('something that takes a while')
  await page.getByTestId('send').click()

  await expect(mark).toHaveAttribute('data-state', 'working')
  await expect(mark).toHaveAttribute('data-look', 'answering')
})

/**
 * Images produced by the agent (#40) — screenshots and image Reads actually show up in the
 * conversation. The decision not to persist them (display-only, 2026-08-24) is upheld by the
 * kind map (null), and two contracts are checked here: an image renders, and an image that
 * cannot render is a box with a reason, not a silent blank.
 */
test('An image sent by the agent renders in the conversation — a failure states its reason', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(
    () => (window as never as { __store: any }).__store.getState().focusedSessionId,
  )
  // An actual 8x8 pixel PNG — a fake string would make it impossible to measure "did it render"
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFtFEIAJ2yAhH+Iz4jAAAAAElFTkSuQmCC'
  await page.evaluate(
    ({ sid, png }: { sid: string; png: string }) => {
      const mock = (window as never as { __mock: any }).__mock
      mock.emit({
        type: 'message_image',
        sessionId: sid,
        mime: 'image/png',
        data: png,
        path: '/tmp/shot.png',
      })
      mock.emit({
        type: 'message_image',
        sessionId: sid,
        mime: '',
        data: '',
        path: '/tmp/big.png',
        note: 'Image is too large (12MB)',
      })
    },
    { sid: id, png: PNG },
  )
  const img = page.getByTestId('msg-image').locator('img')
  await expect(img).toBeVisible()
  // Checks whether it actually decoded — naturalWidth is 0 if the source is broken
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByTestId('msg-image-missing')).toContainText('too large')
  await expect(page.getByTestId('msg-image-missing')).toContainText('/tmp/big.png')

  /*
   * Persistence (#40's second decision: display-only -> kept, capped at 500MB total). The image
   * must come back even after discarding the in-memory conversation and force-reading it back
   * from the transcript — the same path a restart walks.
   */
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByTestId('msg-image-missing')).toContainText('too large')
})

/**
 * The same delta used to get applied multiple times (dogfooding finding: "hohosthosthost...").
 *
 * attach never tore down its subscription, so attaching twice applied every event twice.
 * Streaming deltas accumulate, so one misalignment throws off everything after it.
 */
test('Streaming text is not duplicated even after attaching twice', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // Reproduce exactly the situation of the app reattaching (host reconnect / remount)
  await page.evaluate(async () => {
    const s = (window as any).__store.getState()
    await s.attach(s.platform)
  })

  // Emit the delta exactly once — if subscriptions overlapped, it stacks twice on screen
  await page.evaluate(() => {
    const s = (window as any).__store.getState()
    ;(window as any).__mock.emit({
      type: 'message_delta',
      sessionId: s.focusedSessionId,
      role: 'assistant',
      text: 'abc',
    })
  })

  const reply = page.getByTestId('msg-assistant').last()
  await expect(reply).toHaveText('abc')
})

/**
 * An icon-only button must have **some way to ask what it does.**
 * Building them one at a time leads to some having a tooltip and others not — this actually
 * happened.
 */
test('Hovering an icon button shows its description', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('send').hover()
  await expect(page.getByRole('tooltip')).toContainText('Send')

  await page.getByTestId('restart-session').hover()
  await expect(page.getByRole('tooltip')).toContainText('Restart')

  // Must appear on focus too, not just hover — someone navigating by keyboard alone needs the same information
  await page.getByTestId('restart-session').focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
})

/**
 * The window survives even when rendering blows up (dogfooding finding, 2026-09-07: "it said an
 * error happened and then the screen went blank").
 *
 * When React hits an exception with nothing to catch it, it tears down the entire tree — leaving
 * a blank screen indistinguishable from "the app has died". What breaks here is the shape of a
 * single session, which is an honest choice of test material: it is something that can actually
 * happen if the host sends something malformed.
 */
test('When the screen breaks, it shows what happened instead of a blank page', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(
    () => (window as never as { __store: any }).__store.getState().focusedSessionId,
  )

  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    const s = store.getState()
    // If a spot meant to be an array is empty, the rendering side throws
    store.setState({ sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], touchedPaths: undefined } } })
  }, id)

  await expect(page.getByTestId('app-crashed')).toBeVisible()
  await expect(page.getByTestId('app-crashed-reload')).toBeVisible()
})

/**
 * Tool cards are collapsed by default (dogfooding: "Bash, Edit, MCP should default to closed").
 * Even a few uses buries the conversation in output, making the actual reply unreadable.
 */
test('Tool cards appear collapsed whether Bash or Edit', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await emitEvent(page, 0, {
    type: 'tool_call',
    callId: 'c1',
    summary: { tool: 'Bash', title: 'npm run build', paths: [] },
  })
  await emitEvent(page, 0, {
    type: 'tool_result',
    callId: 'c1',
    ok: true,
    summary: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8',
  })

  const card = page.getByTestId('tool-card').first()
  await expect(card).toBeVisible()
  await expect(card.getByTestId('tool-card-toggle')).toHaveAttribute('aria-expanded', 'false')
  // Even collapsed, what it did remains visible
  await expect(card).toContainText('npm run build')

  // Clicking expands it
  await card.getByTestId('tool-card-toggle').click()
  await expect(card.getByTestId('tool-card-toggle')).toHaveAttribute('aria-expanded', 'true')
  expect(id).toBeTruthy()
})

/**
 * Reasoning is visible (based on #58's measured findings).
 * codex streams summary text, so it stays in the conversation as a gray block; claude's content
 * is encrypted, so only a "Thinking · ~N tokens" progress indicator is possible — not pretending
 * to show content that does not exist is part of the contract too.
 */
test("codex's reasoning summary shows as a gray block and survives a restore", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'reasoning_delta', text: '**Reviewing path constraints**' })
  await emitEvent(page, 0, { type: 'reasoning_delta', text: '\n\n**Checking the minimum count**' })
  await expect(page.getByTestId('msg-reasoning')).toContainText('Reviewing path constraints')
  await expect(page.getByTestId('msg-reasoning')).toContainText('Checking the minimum count')

  // Restore leg: discard the in-memory conversation and force-read it back from the transcript
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: { ...store.getState().chat, [sid]: undefined } })
    return store.getState().loadHistory(sid)
  }, id)
  await expect(page.getByTestId('msg-reasoning')).toContainText('Reviewing path constraints')
})

test("claude's thinking shows as a quantity — Thinking · ~N tokens, and disappears when the turn ends", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'state_change', state: 'working' })
  await emitEvent(page, 0, { type: 'reasoning_delta', estTokens: 500 })
  await emitEvent(page, 0, { type: 'reasoning_delta', estTokens: 1000 })
  await expect(page.getByTestId('activity-label')).toContainText('Thinking · ~1.5k tokens')

  // Nothing remains in the conversation — there was never any content
  await expect(page.getByTestId('msg-reasoning')).toHaveCount(0)

  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('activity-row')).toHaveCount(0)
})

/**
 * A plan is visible (measured for #58, codex's turn/plan/updated).
 * Measured, a plan never arrives as an item — dropping this notification would mean codex's use
 * of the plan tool never appears anywhere on screen. The contract covers snapshot replacement and
 * disappearing when the turn ends.
 */
test("codex's plan shows as a checklist, updates replace the snapshot, and it disappears when the turn ends", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, { type: 'state_change', state: 'working' })
  await emitEvent(page, 0, {
    type: 'plan_update',
    steps: [
      { text: 'Prepare to run the command', status: 'inProgress' },
      { text: 'Run the command', status: 'pending' },
    ],
  })
  await expect(page.getByTestId('activity-plan')).toBeVisible()
  await expect(page.getByTestId('plan-step-0')).toHaveAttribute('data-status', 'inProgress')
  await expect(page.getByTestId('plan-step-1')).toContainText('Run the command')

  // An update is a full snapshot replacement, not delta merging
  await emitEvent(page, 0, {
    type: 'plan_update',
    steps: [
      { text: 'Prepare to run the command', status: 'completed' },
      { text: 'Run the command', status: 'inProgress' },
    ],
  })
  await expect(page.getByTestId('plan-step-0')).toHaveAttribute('data-status', 'completed')
  await expect(page.getByTestId('plan-step-1')).toHaveAttribute('data-status', 'inProgress')

  // Being only a progress indicator, the plan disappears along with the turn's end (the same
  // lifetime as activity)
  await emitEvent(page, 0, { type: 'turn_complete' })
  await expect(page.getByTestId('activity-plan')).toHaveCount(0)
})

/**
 * Live execution output is visible (measured for #58, codex's item/commandExecution/outputDelta).
 * The sum of the chunks is not the whole thing (measured: the first chunk gets lost) — so while
 * running, only the tail is shown, and once complete, a result carrying the full output replaces
 * the chunks.
 */
test('Live tool output streams as a tail, and switches to the result once complete', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await emitEvent(page, 0, {
    type: 'tool_call',
    callId: 'exec-1',
    summary: {
      tool: 'Bash',
      title: 'for i in 1 2 3; do echo tick $i; sleep 1; done',
      paths: [],
    },
  })
  await emitEvent(page, 0, { type: 'tool_output_delta', callId: 'exec-1', text: 'tick 2\n' })
  await emitEvent(page, 0, { type: 'tool_output_delta', callId: 'exec-1', text: 'tick 3\n' })
  await expect(page.getByTestId('tool-card-live')).toContainText('tick 3')

  // Completion: the full output arrives as a result, and the live tail, its job done, disappears
  await emitEvent(page, 0, {
    type: 'tool_result',
    callId: 'exec-1',
    ok: true,
    summary: 'tick 1\ntick 2\ntick 3',
  })
  await expect(page.getByTestId('tool-card-live')).toHaveCount(0)
  await expect(page.getByTestId('tool-card-output')).toContainText('tick 1')
})

test('My own sent message does not render twice', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  await page.getByTestId('prompt-input').fill('the same words')
  await page.getByTestId('send').click()
  // The host reports "that message was added" (the mock does too, #999) — since it is already drawn,
  // this must only confirm it: the bubble takes the stored number, and there is still one
  const mine = () =>
    page.evaluate(() => {
      const st = (window as any).__store.getState()
      const id = st.focusedSessionId
      return st.chat[id].filter((i: any) => i.kind === 'user' && i.text === 'the same words').map((i: any) => typeof i.storedSeq)
    })
  await expect.poll(mine).toEqual(['number'])
})

/** An image attachment shows as a real thumbnail, and clicking opens the same zoom as an agent image */
test('A sent image shows as itself in the bubble and zooms on click', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // An actual 1x1 PNG — fake bytes would break the <img> and fall through to the flat-chip path
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  await page.getByTestId('attach-input').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1PX, 'base64'),
  })
  // The composer already shows it as a thumbnail (#284)
  await expect(page.getByTestId('attachment-thumb').locator('img')).toHaveAttribute('alt', 'pixel.png')
  await page.getByTestId('prompt-input').fill('take a look at this')
  await page.getByTestId('send').click()

  const thumb = page.getByTestId('msg-user-attachment')
  await expect(thumb.locator('img')).toBeVisible()
  await thumb.locator('img').click()
  await expect(page.getByTestId('image-lightbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('image-lightbox')).toHaveCount(0)

  // The thumbnail comes back even reloaded from the store — the rule that the host reloads bytes
  // from the file (the same path as a restart)
  await page.evaluate(async () => {
    const store = (window as any).__store.getState()
    await store.loadHistory(store.focusedSessionId)
  })
  await expect(page.getByTestId('msg-user-attachment').locator('img')).toBeVisible()
})

/**
 * A long error sentence does not create horizontal scroll in the conversation (#107 follow-up).
 *
 * The divider label was built to hold short text like "conversation compacted here", and
 * `shrink-0` was the right value for that. Once failed turns started landing on screen, long
 * sentences like a token expiring landed in the same spot, and that line pushed the panel wide
 * enough to shift the whole conversation sideways (a dogfooding finding). A sentence put up for
 * the person to read is pointless if it sits off screen.
 *
 * What is measured is not the class name but **the width**. Only that answers whether scroll
 * actually appeared.
 */
test('A long error sentence does not push the conversation sideways', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => [...(window as any).__mock.sessions.keys()][0])

  const long =
    'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.'
  await page.evaluate(
    ([sid, message]: [string, string]) => {
      const m = (window as any).__mock
      m.emit({ type: 'error', sessionId: sid, error: { code: 'internal', message, retryable: false } })
    },
    [id, long] as [string, string],
  )

  const mark = page.getByTestId('msg-mark').last()
  await expect(mark).toContainText('refresh token was revoked')

  const overflow = await page.getByTestId('chat-stream').evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
})
