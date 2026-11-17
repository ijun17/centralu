import { expect, test } from '@playwright/test'
import { PERSON, sessionAddress } from '../packages/agent-host/src/mail/address.js'
import { hubSelfId } from '../packages/agent-host/src/links/stored.js'
import { RECOVERY_RELAY_PORT, Relay, freePort, hostCall, seedSession, startHost, withStore, workspace, type RealHost } from './fixtures/real-host.js'

/**
 * A question a session mailed the person, answered in words on its Inbox card (#2327), against a real host: the words reach the session as the answer to
 * that question (`replyTo` names it), not as a new message, and the question no longer waits. Runs in the `recovery` project, whose UI is built against
 * the relay on 5178.
 */

const PROJECT = 'p-ask'
const SESSION = 's-ask'
const QUESTION = 'hub-aaaaaaaa.m_01ARZ3NDEKTSV4RRFFQ69G5F02'

test('a written answer on the question card reaches the session as the answer to that question (#2327)', async ({ page }) => {
  test.setTimeout(60_000)
  const ws = workspace()
  withStore(ws.db, (store) => {
    // A session of this host: the person's answer to one on another computer goes another way (#1987)
    const asker = sessionAddress(hubSelfId(store), SESSION)
    store.settings.setAppSetting('updates.auto', 'false')
    store.projects.addProject({ id: PROJECT, path: ws.project, name: 'ask' })
    seedSession(store, PROJECT, SESSION, 'alpha')
    // The session asks the person, with two choices, as its mail tool writes a question
    const at = Date.now() - 5_000
    store.mailbox.insert(
      {
        id: QUESTION,
        sender: asker,
        senderProject: PROJECT,
        kind: 'message',
        needsReply: true,
        replyTo: null,
        causeId: null,
        depth: 0,
        urgent: false,
        body: 'Should the commit say what changed, or why?',
        facts: {},
        choices: ['What changed', 'Why'],
        subject: 'Commit message',
        dedupeKey: null,
        origin: 'mail',
        legacyThread: null,
        createdAt: at,
      },
      [{ recipient: PERSON, dueAt: at }],
    )
  })
  const port = await freePort()
  const relay = new Relay(() => port)
  let host!: RealHost
  try {
    host = await startHost(ws, port)
    await relay.listen(RECOVERY_RELAY_PORT)
    await page.goto('/')
    await page.getByTestId('counter').click()
    // A thread is named by its first message: the question
    const card = page.getByTestId(`mail-ask-${QUESTION}`)
    await expect(card).toBeVisible()
    const field = card.getByLabel('Your answer')
    // Neither choice: words of the person's own, sent with Enter
    await field.fill('Both, in one line each')
    await field.press('Enter')
    await expect(card).toHaveCount(0)

    const { result } = await hostCall(port, 'mail.thread', { threadId: QUESTION, tail: 100 })
    const view = result as { thread: { ask: unknown }; messages: { body: string; replyTo: string | null; sender: { kind: string }; facts: Record<string, unknown> }[] }
    const answer = view.messages.find((m) => m.sender.kind === 'person')
    expect(answer).toMatchObject({ body: 'Both, in one line each', replyTo: QUESTION })
    // Words of the person's own, not a pick
    expect(answer?.facts.picked).toBeUndefined()
    expect(view.thread.ask).toBeNull()
    await expect(page.getByTestId('app-crashed')).toHaveCount(0)
  } finally {
    await relay.close()
    if (host) await host.kill('SIGTERM')
    ws.cleanup()
  }
})
