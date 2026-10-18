import { test, expect, type Page } from '@playwright/test'
import { setup } from './fixtures/control.js'
import { startSession } from './fixtures/new-session.js'

/**
 * A conversation that has messages but none read yet shows the shape of one (ChatSkeleton) while its history arrives,
 * instead of an empty pane. A brand-new session has nothing to read and shows none. A read that never answers is
 * given up on after 10s: the empty pane is then the truth, and a skeleton left forever would say otherwise.
 */

/**
 * A session the screen heard of but has not read (made elsewhere: the orchestrator, another window); its history read
 * waits for `__releaseHistory()`, or forever. `stored`: the host holds two messages for it, else it is brand new.
 */
async function storedSession(page: Page, stored = true): Promise<string> {
  return page.evaluate((stored) => {
    const w = window as any
    const m = w.__mock
    const project = Object.values(w.__store.getState().projects)[0] as { id: string; path: string }
    return m.agents.createSession({ projectId: project.id, cwd: project.path, tool: 'claude' }).then((info: any) => {
      const row = (seq: number, role: string, text: string) => ({ sessionId: info.id, seq, role, kind: 'text', payload: { text }, ts: Date.now() })
      const read = m.agents.loadMessages
      m.agents.loadMessages = (sid: string, ...rest: unknown[]) =>
        sid === info.id ? new Promise((done) => (w.__releaseHistory = () => done(read(sid, ...rest)))) : read(sid, ...rest)
      if (stored) {
        m.messages.set(info.id, [row(1, 'user', 'What changed?'), row(2, 'assistant', 'Two files.')])
        m.sessions.get(info.id).lastSeq = 2
        // The screen heard of it at its creation, with nothing stored; its summary now says two messages are
        w.__store.setState((s: any) => ({ sessions: { ...s.sessions, [info.id]: { ...s.sessions[info.id], lastSeq: 2 } } }))
      }
      return info.id as string
    })
  }, stored)
}

const focus = (page: Page, id: string) => page.evaluate((sid) => (window as any).__store.getState().focusSession(sid), id)

test('a conversation not read yet shows its shape until the history arrives', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await storedSession(page)
  await focus(page, id)
  await expect(page.getByTestId('chat-skeleton')).toBeVisible()
  await expect(page.getByTestId('msg-user')).toHaveCount(0)

  await page.evaluate(() => (window as any).__releaseHistory())
  await expect(page.getByTestId('msg-user')).toHaveText('What changed?')
  await expect(page.getByTestId('chat-skeleton')).toHaveCount(0)
})

test('a brand-new session has nothing to read and shows no skeleton', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // One the person made from the project menu
  await startSession(page, 'alpha')
  await expect(page.getByTestId('session-start')).toBeVisible()
  await expect(page.getByTestId('chat-skeleton')).toHaveCount(0)

  // One made elsewhere, whose (empty) history the screen has not read yet
  const id = await storedSession(page, false)
  await focus(page, id)
  await expect(page.getByTestId('session-start')).toBeVisible()
  await expect(page.getByTestId('chat-skeleton')).toHaveCount(0)
})

test('a read that never answers is given up on after 10s, leaving the empty pane', async ({ page }) => {
  await page.clock.install()
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await storedSession(page)
  await focus(page, id)
  await expect(page.getByTestId('chat-skeleton')).toBeVisible()
  // Still there just before the bound
  await page.clock.runFor(9_000)
  await expect(page.getByTestId('chat-skeleton')).toBeVisible()
  await page.clock.runFor(1_500)
  await expect(page.getByTestId('chat-skeleton')).toHaveCount(0)
  await expect(page.getByTestId('msg-user')).toHaveCount(0)
})
