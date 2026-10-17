import { test, expect, type Page } from '@playwright/test'
import { setup, newSession, emitEvent, dropFile, QUESTIONS } from './fixtures/control.js'

/**
 * The control loop's scenarios on the composer: attachments, drops, slash and @ completion, history recall and drafts. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

test('Attachments: attaching a file shows it in the list and rides along with the send (D, FR-13)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('attach-input').setInputFiles({
    name: 'screenshot.png',
    mimeType: 'image/png',
    buffer: Buffer.from('fake image data'),
  })
  await expect(page.getByTestId('attachment-list')).toContainText('screenshot.png')

  await page.getByTestId('prompt-input').fill('take a look at this screen')
  await page.getByTestId('send').click()

  const sent = await page.evaluate(() => (window as any).__mock.sentAttachments)
  expect(sent).toHaveLength(1)
  expect(sent[0].name).toBe('screenshot.png')
  // The attachment also shows up in the conversation
  await expect(page.getByTestId('msg-user').last()).toContainText('screenshot.png')
})

test('Sending with only an attachment and no text works (D abnormal path: empty text)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await expect(page.getByTestId('send')).toBeDisabled()
  await page.getByTestId('attach-input').setInputFiles({
    name: 'a.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.getByTestId('send')).toBeEnabled()
})

test('Dragging and dropping also attaches a file', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // On the assumption that the webview does not intercept the drop, checks whether the dropped
  // file is captured as an attachment
  const dt = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.items.add(new File(['screenshot content'], 'shot.png', { type: 'image/png' }))
    return data
  })
  await page.getByTestId('input-dropzone').dispatchEvent('drop', { dataTransfer: dt })

  await expect(page.getByTestId('attachment-list')).toContainText('shot.png')
  await page.getByTestId('send').click()
  const sent = await page.evaluate(() => (window as any).__mock.sentAttachments)
  expect(sent.at(-1).name).toBe('shot.png')
})

test('Drag-and-drop defaults to rejection across the whole window — even where there is no drop target', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const before = page.url()

  /*
    This check stands **separately** from the attachment feature. What is checked here is not
    "did it attach" but "did the browser refrain from deciding on its own", so it deliberately
    picks **spots that receive nothing** — the sidebar background and the document background.
    These are exactly the spots where a PDF used to cover the window.

    preventDefault means "the webview will not open this". All three must be checked: dragover
    and dragenter are the answer to "can something be dropped here", and if that is not blocked,
    the decision falls to the browser.
  */
  const floor = await page.evaluate(() => {
    const out: Record<string, boolean[]> = {}
    for (const where of ['sidebar', 'body']) {
      const el = where === 'body' ? document.body : document.querySelector('[data-testid="sidebar"]')!
      const data = new DataTransfer()
      data.items.add(new File(['report'], 'report.pdf', { type: 'application/pdf' }))
      out[where] = ['dragenter', 'dragover', 'drop'].map((type) => {
        const e = new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true })
        el.dispatchEvent(e)
        return e.defaultPrevented
      })
    }
    return out
  })
  expect(floor).toEqual({ sidebar: [true, true, true], body: [true, true, true] })

  // And the app stays exactly where it was — this bug's symptom was "the app disappears"
  expect(page.url()).toBe(before)

  /*
    There is exactly one narrow exception. **Text dropped over a text field** is allowed through,
    as an editing action — blocking even dragging selected text into a search box would let the
    floor built for files also sweep away text. **Files are still blocked even over a text
    field**: dropping a PDF on a search box is just as much a path for the webview to open the
    file.
  */
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  const overInput = await page.evaluate(() => {
    // The text field must not preventDefault on its own, so that this measures the **global
    // floor**. The composer's own form already preventDefaults its own spot, so measuring there
    // would pass even with the guard removed, proving nothing.
    const el = document.querySelector('[data-testid="palette-input"]')!
    const drag = (kind: 'text' | 'file') => {
      const data = new DataTransfer()
      if (kind === 'file') data.items.add(new File(['report'], 'report.pdf', { type: 'application/pdf' }))
      else data.setData('text/plain', 'dragged-in text')
      const e = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true })
      el.dispatchEvent(e)
      return e.defaultPrevented
    }
    return { text: drag('text'), file: drag('file') }
  })
  expect(overInput.file).toBe(true)
  expect(overInput.text).toBe(false)
  await expect(page.getByTestId('session-view')).toBeVisible()
})

test('Dropping anywhere in the panel, not just the composer, still attaches', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  // The middle of the conversation — a spot that does not overlap the composer. This is exactly
  // where this bug lived.
  await page
    .getByTestId('chat-stream')
    .dispatchEvent('drop', { dataTransfer: await dropFile(page, 'report.pdf') })

  await expect(page.getByTestId('attachment-list')).toContainText('report.pdf')
  await page.getByTestId('send').click()
  const sent = await page.evaluate(() => (window as any).__mock.sentAttachments)
  expect(sent.at(-1).name).toBe('report.pdf')
})

/** Slash/@ autocomplete (M2.8) */
test('Typing a slash shows skills, and @ shows files', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.commandState = {
      ready: true,
      commands: [
        { name: 'review', description: 'Reviews the changes', argumentHint: '<path>' },
        { name: 'commit', description: 'Commits', argumentHint: '' },
      ],
    }
    m.fsState.entries[''] = [
      { name: 'SessionView.tsx', path: 'src/SessionView.tsx', isDir: false, ignored: false },
      { name: 'store.ts', path: 'src/store.ts', isDir: false, ignored: false },
    ]
  })
  await newSession(page, 'alpha', 'task')

  // Slash — only at the very start
  await page.getByTestId('prompt-input').fill('/rev')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('/review')
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('<path>')

  // Picking with Enter fills the composer
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('prompt-input')).toHaveValue('/review ')
  await expect(page.getByTestId('autocomplete')).toBeHidden()

  // @ — files
  await page.getByTestId('prompt-input').fill('take a look at this @Session')
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('SessionView.tsx')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('prompt-input')).toHaveValue('take a look at this @src/SessionView.tsx ')
})

/** Lets the person act before a queued caret move, without depending on machine speed. */
async function holdComposerFrames(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const frame = window.requestAnimationFrame
    const held: FrameRequestCallback[] = []
    window.requestAnimationFrame = (callback) => (held.push(callback), 0)
    ;(window as any).__releaseComposerFrames = () => {
      window.requestAnimationFrame = frame
      for (const callback of held) callback(performance.now())
    }
  })
  return () => page.evaluate(() => (window as any).__releaseComposerFrames())
}

for (const trigger of ['/rev', '@Session']) {
  test(`Replacing text after picking ${trigger} keeps the person's selection`, async ({ page }) => {
    await setup(page, { projects: ['/tmp/alpha'] })
    await page.evaluate(() => {
      const m = (window as any).__mock
      m.commandState = { ready: true, commands: [{ name: 'review', description: '', argumentHint: '' }] }
      m.fsState.entries[''] = [
        { name: 'SessionView.tsx', path: 'src/SessionView.tsx', isDir: false, ignored: false },
      ]
    })
    await newSession(page, 'alpha', 'task')
    const input = page.getByTestId('prompt-input')
    await input.fill(trigger)
    await expect(page.getByTestId('autocomplete-item-0')).toContainText(trigger === '/rev' ? '/review' : 'SessionView.tsx')

    // Hold the pick's next-frame caret move until after the person selects the replacement.
    // This is the interleaving behind #368; fill() also selects before inserting its text.
    const release = await holdComposerFrames(page)
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue(trigger === '/rev' ? '/review ' : '@src/SessionView.tsx ')
    await page.keyboard.press('ControlOrMeta+A')
    await release()
    await page.keyboard.insertText('take a look at this @Session')
    await expect(input).toHaveValue('take a look at this @Session')
    await expect(page.getByTestId('autocomplete-item-0')).toContainText('SessionView.tsx')
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue('take a look at this @src/SessionView.tsx ')
  })
}

for (const source of [
  'history recall',
  'history recall with a matching draft',
  'dropping a tree path',
  'dropping a link',
  'dropping text',
]) {
  test(`Replacing text after ${source} keeps the person's selection`, async ({ page }) => {
    await setup(page, { projects: ['/tmp/alpha'] })
    await newSession(page, 'alpha', 'sent message')
    const input = page.getByTestId('prompt-input')
    const recalling = source.startsWith('history recall')
    const draft = source === 'history recall with a matching draft'
      ? 'sent message'
      : recalling ? 'unsent draft' : 'see please'
    await input.fill(draft)
    // A link/text drop belongs in the middle; a tree path still belongs at the end.
    if (source !== 'history recall with a matching draft') {
      await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 4))
    }
    const release = await holdComposerFrames(page)
    if (recalling) {
      await page.keyboard.press('ArrowUp')
      await expect(input).toHaveValue('sent message')
    } else {
      const data = await page.evaluateHandle((kind) => {
        const dt = new DataTransfer()
        if (kind === 'dropping a tree path') dt.setData('application/x-cc-path', 'src/a.ts')
        else {
          dt.setData('text/plain', kind === 'dropping a link' ? 'reference' : 'dropped note')
          if (kind === 'dropping a link') dt.setData('text/uri-list', 'https://example.test/reference')
        }
        return dt
      }, source)
      await page.getByTestId('input-dropzone').dispatchEvent('drop', { dataTransfer: data })
      await data.dispose()
      const expected = source === 'dropping a tree path'
        ? 'see please @src/a.ts '
        : source === 'dropping a link'
          ? 'see [reference](https://example.test/reference) please'
          : 'see dropped note please'
      await expect(input).toHaveValue(expected)
    }
    await page.keyboard.press('ControlOrMeta+A')
    await release()
    await page.keyboard.insertText('replacement text')
    await expect(input).toHaveValue('replacement text')
    if (recalling) {
      // Editing recalled text still leaves the session's unfinished draft intact.
      await page.keyboard.press('ArrowDown')
      await expect(input).toHaveValue(draft)
    }
  })
}

test('When skills have not loaded yet, it does not claim there are none', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    // Right after creating a session, the CLI is still starting up and cannot be queried yet
    ;(window as any).__mock.commandState = { ready: false, commands: [] }
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('prompt-input').fill('/')
  await expect(page.getByTestId('autocomplete-loading')).toContainText('Loading skills')
})

test('A slash in the middle of a sentence is not treated as a command', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.commandState = {
      ready: true,
      commands: [{ name: 'review', description: '', argumentHint: '' }],
    }
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('prompt-input').fill('the path is src/rev')
  await expect(page.getByTestId('autocomplete')).toBeHidden()
})

/**
 * An empty composer used to stay stuck at its grown height (dogfooding finding).
 * Computing height only on typing events leaves the value empty after sending but keeps the
 * height.
 */
test('The composer height returns to one line after sending a message', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  const input = page.getByTestId('prompt-input')
  const oneLine = (await input.boundingBox())!.height

  await input.fill('line one\nline two\nline three\nline four')
  const grown = (await input.boundingBox())!.height
  expect(grown).toBeGreaterThan(oneLine + 20)

  await page.getByTestId('send').click()
  await expect(input).toHaveValue('')

  // If the value is empty, the height must also be one line — a tall box must not linger with nothing typed
  expect((await input.boundingBox())!.height).toBeCloseTo(oneLine, 0)
})

test('The composer height also follows a value inserted by autocomplete', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'a'.repeat(120) + '.ts', path: 'src/' + 'a'.repeat(120) + '.ts', isDir: false, ignored: false },
    ]
  })
  await newSession(page, 'alpha', 'task')

  const input = page.getByTestId('prompt-input')

  await input.fill('@a')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  const beforePick = (await input.boundingBox())!.height
  await page.keyboard.press('Tab')

  // Once picked, the value is longer, so the box must grow too
  await expect(input).not.toHaveValue('@a')
  expect((await input.boundingBox())!.height).toBeGreaterThan(beforePick)
})

/** So a path never has to be memorized and typed — drag it from the tree and drop it on the composer */
test('Dragging from the file tree drops an @path into the composer', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'a.ts', path: 'src/a.ts', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-tab-files').click()

  await page.getByTestId('prompt-input').fill('take a look at this')
  await page.dragAndDrop('[data-testid="file-src/a.ts"]', '[data-testid="input-dropzone"]')

  // Must be the same shape autocomplete would insert
  await expect(page.getByTestId('prompt-input')).toHaveValue('take a look at this @src/a.ts ')
})

/** The composer's attach and send are the same kind of part, so their size and height must match */
test("The composer's attach and send buttons share the same size and height", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  const attach = (await page.getByTestId('attach-open').boundingBox())!
  const send = (await page.getByTestId('send').boundingBox())!

  expect(Math.abs(attach.width - send.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(attach.height - send.height)).toBeLessThanOrEqual(1)
  // Their bottom edges align on the same line (they stay side by side even as the composer grows)
  expect(Math.abs(attach.y + attach.height - (send.y + send.height))).toBeLessThanOrEqual(1)
})

/**
 * "What I was typing to A is sitting in B's composer" — sending it as-is would go to the wrong
 * session (confirmed by measurement). The cause: an unfinished draft was attached to that spot
 * on screen rather than to the session.
 */
test('An unfinished draft does not follow the wrong session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'second')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId(`session-row-${a}`).click()
  await page.getByTestId('prompt-input').fill('what I meant to say to A')

  // B's composer must be empty
  await page.getByTestId(`session-row-${b}`).click()
  await expect(page.getByTestId('prompt-input')).toHaveValue('')

  // Returning to A, the unfinished draft must still be there
  await page.getByTestId(`session-row-${a}`).click()
  await expect(page.getByTestId('prompt-input')).toHaveValue('what I meant to say to A')
})
/** Confirms that sending actually attaches to the conversation — history is drawn from what attached (#38) */
async function sendMessage(page: Page, body: string) {
  const seen = await page.getByTestId('msg-user').count()
  await page.getByTestId('prompt-input').fill(body)
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('msg-user')).toHaveCount(seen + 1)
}

/**
 * Arrow keys recall only what the person sent (#745): a brief another session sent through Centralu's tools, or a
 * message an app view wrote, is in the conversation as a user message but was never typed here.
 */
test('arrow up skips messages other sessions and app views sent (#745)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first prompt')
  await emitEvent(page, 0, {
    type: 'user_message', seq: 991, text: 'Fix issue #12. Rules: run the tests first.',
    from: { sessionId: 'parent-session', name: 'parent session' },
  })
  await emitEvent(page, 0, {
    type: 'user_message', seq: 992, text: 'Open the board',
    fromApp: { appId: 'board', projectId: null, name: 'Board' },
  })
  await expect(page.getByTestId('msg-user-from')).toHaveCount(1)

  const input = page.getByTestId('prompt-input')
  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('first prompt')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('first prompt')
})

/**
 * Arrow keys recall what was sent (#38).
 *
 * Exactly like a shell. No separate history is stored — the conversation itself already holds
 * everything said.
 */
test('arrow up walks back through what you sent, arrow down walks forward (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first prompt')
  await sendMessage(page, 'second thing sent')
  await sendMessage(page, 'third thing sent')

  const input = page.getByTestId('prompt-input')
  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('third thing sent')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('second thing sent')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('first prompt')

  // Pressing further up from the oldest entry stays at that entry — if the cursor moved, it reads
  // as "not registering"
  await input.press('ArrowUp')
  await expect(input).toHaveValue('first prompt')

  await input.press('ArrowDown')
  await expect(input).toHaveValue('second thing sent')
})

/**
 * An unfinished draft is not something a single arrow key press can lose.
 *
 * This is exactly the kind of loss this app has fixed repeatedly, so the draft is never touched
 * at all while recalling.
 */
test('arrow down past the newest gives the unsent draft back (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'sent message')

  const input = page.getByTestId('prompt-input')
  await input.fill('not yet sent text')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('sent message')

  await input.press('ArrowDown')
  await expect(input).toHaveValue('not yet sent text')
})

/** Recall belongs to the current conversation — if someone else's message sat in my composer it would be sent as-is */
test('recall does not reach into another session (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'what I said to A')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'what I said to B')

  const input = page.getByTestId('prompt-input')
  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('what I said to B')

  // Switching sessions does not carry the recalled text along
  await page.getByTestId(`session-row-${a}`).click()
  await expect(input).toHaveValue('')
  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('what I said to A')
})

/**
 * While autocomplete is open, the arrows belong to the list.
 *
 * Both want the arrows, and whichever is open wins — if the composer swapped to an old message
 * entirely while a list was open and being navigated, there would be no way to know what just
 * happened.
 */
test('the autocomplete list keeps the arrows while it is open (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    ;(window as any).__mock.commandState = {
      ready: true,
      commands: [
        { name: 'review', description: 'Reviews the changes', argumentHint: '' },
        { name: 'restart', description: 'Restarts', argumentHint: '' },
      ],
    }
  })
  await newSession(page, 'alpha', 'sent message')

  const input = page.getByTestId('prompt-input')
  await input.fill('/re')
  await expect(page.getByTestId('autocomplete')).toBeVisible()
  await expect(page.getByTestId('autocomplete-item-0')).toHaveAttribute('aria-selected', 'true')

  await input.press('ArrowDown')
  // The selected row moved, and the composer keeps exactly what was typed
  await expect(page.getByTestId('autocomplete-item-1')).toHaveAttribute('aria-selected', 'true')
  await expect(input).toHaveValue('/re')

  await input.press('ArrowUp')
  await expect(page.getByTestId('autocomplete-item-0')).toHaveAttribute('aria-selected', 'true')
  await expect(input).toHaveValue('/re')
})

/**
 * While writing multiple lines, the arrows belong to the caret first.
 *
 * Only up from the first line, or down from the last line, brings up history. The hand already
 * knows this rule (from shells and devtools), so there is nothing new to learn.
 */
test('in a multi-line draft the arrows move the caret first (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'sent message')

  const input = page.getByTestId('prompt-input')
  await input.fill('line one\nline two')

  // The caret sits at the end (= the last line) — up moves the caret
  await input.press('ArrowUp')
  await expect(input).toHaveValue('line one\nline two')

  // Now it is on the first line — pressing once more here brings up history
  await input.press('ArrowUp')
  await expect(input).toHaveValue('sent message')
})

/**
 * Even in a single line wrapped into several visual lines, the arrows belong to the caret first
 * (pointed out by the person, 2026-09-07).
 *
 * There is no newline, but the eye sees three lines. It used to count only newlines, so pressing
 * from any line counted as "the first line" and brought up history — the text being written
 * appeared to vanish.
 */
test('a long wrapped line moves the caret before it recalls history (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'sent message')

  const input = page.getByTestId('prompt-input')
  // A single line, no newlines, wide enough to wrap the composer's width several times
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
  await input.fill(long)

  // First confirm it actually wrapped into multiple lines — without wrapping this test sees nothing
  const rows = await input.evaluate((el: HTMLTextAreaElement) => {
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16
    return Math.round(el.scrollHeight / lh)
  })
  expect(rows).toBeGreaterThan(1)

  // The caret sits at the end (= the last wrapped line) — up moves the caret, not history
  await input.press('ArrowUp')
  await expect(input).toHaveValue(long)
  const moved = await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)
  expect(moved).toBeLessThan(long.length)

  // Once it reaches the very top line, history takes over from there (no matter how many times it
  // wrapped, pressing up repeatedly reaches it)
  for (let i = 0; i < rows + 1; i++) await input.press('ArrowUp')
  await expect(input).toHaveValue('sent message')
})

/**
 * An arrow key while composing belongs to the candidate list (#12).
 *
 * For someone typing Korean, Japanese, or Chinese, the arrow keys also pick among candidate
 * characters. Intercepting it here would wipe out the character being chosen entirely — this
 * constructs the keyboard event by hand to declare composition is in progress, a state that
 * cannot be reproduced by an actual human hand.
 */
test('arrows do not recall while an IME is composing (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'sent message')

  const input = page.getByTestId('prompt-input')
  await input.fill('ㅎ')
  await input.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', isComposing: true, bubbles: true }))
  })
  await expect(input).toHaveValue('ㅎ')

  // Once composition ends, the same key brings up history
  await input.press('ArrowUp')
  await expect(input).toHaveValue('sent message')
})

/**
 * A recalled message grows the composer exactly like typed text does.
 *
 * Height is derived from the value, so adding one more path should follow automatically — but
 * "it should follow" and "it does follow" are different claims, so this measures it.
 */
test('a recalled multi-line message grows the composer (#38)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'one line')

  const input = page.getByTestId('prompt-input')
  await sendMessage(page, 'line one\nline two\nline three')
  const short = await input.evaluate((el) => el.clientHeight)

  await input.click()
  await input.press('ArrowUp')
  await expect(input).toHaveValue('line one\nline two\nline three')
  expect(await input.evaluate((el) => el.clientHeight)).toBeGreaterThan(short)
})

/**
 * Focusing the composer wakes a dormant session.
 *
 * Selecting it from the sidebar already wakes it (focusSession -> wake). But there are two paths
 * that reach the composer **without** selecting — a grid panel, and the focused session a
 * restart restores. Both stayed dormant until sending, so the few seconds of resuming ran hidden
 * behind the send button, and the slash list only answered from the disk cache (the same one
 * that kept showing a removed plugin's commands for days).
 */
test('Focusing the composer wakes a dormant session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Set up the dormant state — the focused session a restart restores is exactly this shape
  await page.evaluate((sid: string) => {
    const st = (window as any).__store
    const m = (window as any).__mock
    ;[...m.sessions.values()].find((x: any) => x.id === sid)!.live = false
    st.setState({
      sessions: { ...st.getState().sessions, [sid]: { ...st.getState().sessions[sid], live: false } },
    })
  }, id)

  // Since the helper leaves focus in the composer, this leaves and comes back once. The person's press wakes it;
  // a focus the app gives does not (#590), so this clicks rather than calling focus()
  await page.getByTestId('prompt-input').blur()
  await page.getByTestId('prompt-input').click()
  await expect
    .poll(() => page.evaluate((sid: string) => (window as any).__store.getState().sessions[sid].live, id))
    .toBe(true)
  // Quietly — no "woke up" toast and no failure toast either
  await expect(page.getByTestId('toast')).toHaveCount(0)
})

/** #75: a message carrying an attachment renders only once — since text stays exactly as sent, confirmation matches up cleanly */
test('A message sent with an attachment renders only once', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first greeting')

  // Send with an attachment — the mock echoes back a user_message with just the raw text, the
  // same as the real host
  await page.evaluate(async () => {
    const store = (window as any).__store.getState()
    const sid = Object.keys(store.sessions).find((id: string) => store.sessions[id].name !== 'Orchestrator')
    await store.send(sid, 'take a look at this image', [
      { kind: 'image', path: '/tmp/att/shot.png', name: 'shot.png', mime: 'image/png', bytes: 10 },
    ])
  })

  const bubbles = page.getByText('take a look at this image')
  await expect(bubbles).toHaveCount(1)
  // An attachment with no bytes lies flat as a name chip — what was sent remains visible
  await expect(page.getByTestId('msg-user-attachment')).toContainText('shot.png')
})

/**
 * The rest of #125 (#174): when text cannot be the answer (multiple questions, or an attachment
 * present), the composer says so before it is sent, and if sending drops the question anyway, a
 * line stays in the conversation. While the hint never checked attachments, attaching a file
 * under a "write your answer" hint sent the text as a new turn and silently dropped the question.
 */
test('The composer states first that text cannot answer once any file is attached to a question (#174)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'q')
  await emitEvent(page, 0, { type: 'question_request', requestId: 'q1', questions: [QUESTIONS[0]] })
  await expect(page.getByTestId('prompt-input')).toHaveAttribute('placeholder', /answer to the question/i)

  // Attaching a file makes it unable to answer — the hint changes immediately
  await page
    .getByTestId('attach-input')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
  await expect(page.getByTestId('attachment-list')).toContainText('notes.txt')
  await expect(page.getByTestId('prompt-input')).toHaveAttribute('placeholder', /drops the question card/i)
})

test('Nothing sends while an attachment is uploading, and it goes out with the text once it finishes (#180)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  await page.evaluate(() => {
    const w = window as any
    const save = w.__mock.agents.saveAttachment
    w.__release = null
    w.__mock.agents.saveAttachment = async (...a: unknown[]) => {
      await new Promise<void>((r) => (w.__release = r))
      return save(...a)
    }
  })
  await page
    .getByTestId('attach-input')
    .setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('png') })
  // Keep the picked file pending and clear the field — picking the same file again still fires a
  // change event
  await expect(page.getByTestId('attach-input')).toHaveValue('')
  await expect(page.getByTestId('attachment-uploading')).toBeVisible()

  await page.getByTestId('prompt-input').fill('take a look at this')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('send')).toBeDisabled()
  await expect(page.getByTestId('prompt-input')).toHaveValue('take a look at this')
  expect(await page.evaluate(() => (window as any).__mock.sentAttachments.length)).toBe(0)

  await page.evaluate(() => (window as any).__release())
  await expect(page.getByTestId('attachment-list')).toContainText('shot.png')
  await page.getByTestId('prompt-input').press('Enter')
  await expect(page.getByTestId('msg-user').last()).toContainText('shot.png')
  expect(
    await page.evaluate(() => (window as any).__mock.sentAttachments.map((a: { name: string }) => a.name)),
  ).toEqual(['shot.png'])
})

/*
 * #842 item 13: the file list on screen answers the previous keystroke until the new search answers. Enter in that
 * moment inserted one of the previous query's files.
 */
test('Enter while the @ search for the latest keystroke is on its way picks nothing stale, and sends nothing', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [
      { name: 'store.ts', path: 'src/store.ts', isDir: false, ignored: false },
      { name: 'stats.ts', path: 'src/stats.ts', isDir: false, ignored: false },
    ]
    const real = m.fs.search
    // The searches for "sta" and "stat" wait for the test; "st" answers at once
    const waiting: (() => void)[] = []
    ;(window as any).__answerStat = () => waiting.splice(0).forEach((answer) => answer())
    m.fs.search = (projectId: string, query: string, limit: number) => {
      if (!query.startsWith('sta')) return real(projectId, query, limit)
      return new Promise((done) => waiting.push(() => done(real(projectId, query, limit))))
    }
  })
  await newSession(page, 'alpha', 'task')
  const input = page.getByTestId('prompt-input')
  await input.fill('look at @st')
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('store.ts')

  // Enter at once: the list waits for this keystroke's answer, and says it is searching
  await page.keyboard.type('at')
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('look at @stat')
  await expect(page.getByTestId('autocomplete-loading')).toHaveText('Searching…')

  await page.evaluate(() => (window as any).__answerStat())
  await expect(page.getByTestId('autocomplete-item-0')).toContainText('stats.ts')
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('look at @src/stats.ts ')
})

/* #842 review of item 13: a search that never answers does not hold the composer, and a query that found nothing does not reopen the menu */
test('a hung @ search stops holding Enter, and the message goes out', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'store.ts', path: 'src/store.ts', isDir: false, ignored: false }]
    const real = m.fs.search
    m.fs.search = (projectId: string, query: string, limit: number) =>
      query === 'nev' ? new Promise(() => {}) : real(projectId, query, limit)
  })
  await newSession(page, 'alpha', 'task')
  const input = page.getByTestId('prompt-input')
  await input.fill('look at @ne')
  await page.keyboard.type('v')
  // The wait is bounded: once it gives up the list closes, and Enter sends
  await expect(page.getByTestId('autocomplete')).toBeHidden({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('chat-stream')).toContainText('look at @nev')
})

test('narrowing an @ query that found nothing does not bring the menu back', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'store.ts', path: 'src/store.ts', isDir: false, ignored: false }]
    ;(window as any).__menuSeen = 0
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="autocomplete"]')) (window as any).__menuSeen++
    }).observe(document.body, { childList: true, subtree: true })
  })
  await newSession(page, 'alpha', 'task')
  const input = page.getByTestId('prompt-input')
  await input.fill('look at @zz')
  await expect(page.getByTestId('autocomplete')).toBeHidden()
  await page.evaluate(() => ((window as any).__menuSeen = 0))
  await page.keyboard.type('zzz')
  await expect(input).toHaveValue('look at @zzzzz')
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => (window as any).__menuSeen)).toBe(0)
})
