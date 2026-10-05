import { expect, test, type Page } from '@playwright/test'
import { Relay } from './real-host.js'
import { LINKED_RELAY_PORT, LINKED_TOKEN, MACHINE, startPair, type LinkedPair } from './linked-hosts.js'

/**
 * The real UI on a hub linked to a second host (#82, docs/plans/remote-hub.md §8 probes 1 and 2).
 * A function, because it runs in Chromium and in WebKit (linked-hosts-webkit.spec.ts): the desktop
 * app is WKWebView.
 */

/** One call over the hub's own protocol, straight to the hub (not through the relay) */
export async function hubCall(port: number, method: string, params: unknown): Promise<unknown> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000)
      socket.onerror = () => reject(new Error('socket error'))
      socket.onopen = () => socket.send(JSON.stringify({ kind: 'hello', token: LINKED_TOKEN, protocolVersion: 1 }))
      socket.onmessage = (m) => {
        const f = JSON.parse(String(m.data)) as { kind: string; id?: string; ok?: boolean; result?: unknown; error?: { message: string } }
        if (f.kind === 'hello_ok') socket.send(JSON.stringify({ kind: 'rpc', id: 'call', method, params }))
        if (f.kind === 'res' && f.id === 'call') {
          clearTimeout(timer)
          if (f.ok) resolve(f.result)
          else reject(new Error(f.error?.message ?? 'host error'))
        }
      }
    })
  } finally {
    socket.close()
  }
}

async function connected(pair: LinkedPair): Promise<void> {
  await expect
    .poll(async () => ((await hubCall(pair.hub.port, 'machines.list', {})) as { status: string }[])[0]?.status, { timeout: 15_000 })
    .toBe('connected')
}

/** The id of the newest session on the remote machine, as the hub's UI holds it */
async function remoteSessionIds(pair: LinkedPair): Promise<string[]> {
  const list = (await hubCall(pair.hub.port, 'sessions.list', {})) as { id: string; machine?: string | null }[]
  return list.filter((s) => s.machine === MACHINE).map((s) => s.id)
}

async function send(page: Page, text: string) {
  await page.getByTestId('prompt-input').fill(text)
  await page.getByTestId('prompt-input').press('Enter')
}

export function linkedHostsTests(): void {
  test('a session on a linked machine: create, send, approve, answer, terminal, trash', async ({ page }) => {
    test.setTimeout(120_000)
    const pair = await startPair()
    const relay = new Relay(() => pair.hub.port)
    try {
      await relay.listen(LINKED_RELAY_PORT)
      await connected(pair)
      await page.goto('/')
      await expect(page.getByTestId('project-hub-project')).toBeVisible()
      await expect(page.getByTestId('project-remote-project')).toBeVisible()

      await test.step('create a session in the remote project', async () => {
        await page.getByTestId('project-menu-remote-project').click()
        await page.getByTestId('new-session-remote-project').click()
        await page.getByTestId('create-session-confirm').click()
        await expect(page.getByTestId('new-session-dialog')).toBeHidden()
        await expect.poll(() => remoteSessionIds(pair)).toHaveLength(1)
      })
      const [id] = await remoteSessionIds(pair)
      expect(id).toMatch(/^m1\./)
      await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()

      await test.step('send, and the reply streams back', async () => {
        await send(page, 'hello there')
        await expect(page.getByTestId('chat-stream')).toContainText('echo: hello there')
      })

      await test.step('approve', async () => {
        await send(page, 'please approve this')
        await expect(page.getByTestId('approval-card')).toBeVisible()
        await page.getByTestId('approval-card').getByTestId('approve-allow').click()
        await expect(page.getByTestId('approval-card')).toBeHidden()
        await expect(page.getByTestId('chat-stream')).toContainText('approved')
      })

      await test.step('answer a question', async () => {
        await send(page, 'ask me a question')
        await expect(page.getByTestId('question-card')).toBeVisible()
        await page.getByTestId('question-option').filter({ hasText: 'Yes' }).click()
        await page.getByTestId('question-submit').click()
        await expect(page.getByTestId('question-card')).toHaveCount(0)
        await expect(page.getByTestId('chat-stream')).toContainText('answered: Yes')
      })

      await test.step('a terminal in the remote project', async () => {
        await page.getByTestId('evidence-tab-terminal').click()
        await expect(page.getByTestId('evidence-terminal')).toBeVisible()
        const surface = page.getByTestId('evidence-terminal').locator('[data-testid^="terminal-surface-m1."]').first()
        await expect(surface).toBeVisible()
        await surface.click()
        await page.keyboard.type('echo hi-from-$((40+2))')
        await page.keyboard.press('Enter')
        await expect(surface).toContainText('hi-from-42')
      })

      await test.step('trash the session', async () => {
        await page.getByTestId(`session-menu-${id}`).click()
        await page.getByTestId(`delete-session-${id}`).click()
        await page.getByTestId('confirm-delete-yes').click()
        await expect(page.getByTestId(`session-row-${id}`)).toHaveCount(0)
        const trash = (await hubCall(pair.hub.port, 'trash.list', {})) as { sessions: { id: string }[] }
        expect(trash.sessions.map((s) => s.id)).toContain(id)
      })
    } catch (err) {
      console.log(`--- hub stderr ---\n${pair.hub.stderr()}\n--- remote stderr ---\n${pair.remote.stderr()}`)
      throw err
    } finally {
      await relay.close()
      await pair.cleanup()
    }
  })

  test('a linked machine that goes away: its sessions stay listed and are not woken', async ({ page }) => {
    test.setTimeout(120_000)
    const pair = await startPair()
    const relay = new Relay(() => pair.hub.port)
    try {
      await relay.listen(LINKED_RELAY_PORT)
      await connected(pair)
      const remoteProject = ((await hubCall(pair.hub.port, 'projects.list', {})) as { id: string; path: string; machine?: string }[]).find(
        (p) => p.machine === MACHINE,
      )!
      const s = (await hubCall(pair.hub.port, 'agents.createSession', { projectId: remoteProject.id, cwd: remoteProject.path, tool: 'claude' })) as { id: string }
      await page.goto('/')
      await expect(page.getByTestId(`session-row-${s.id}`)).toBeVisible()
      // Every resumeSession the page sends, counted at the hub's door
      const resumes: string[] = []
      page.on('websocket', (ws) => ws.on('framesent', (f) => String(f.payload).includes('agents.resumeSession') && resumes.push(String(f.payload))))

      await test.step('the remote host stops; the UI reconnects to the hub', async () => {
        await pair.remote.kill('SIGKILL')
        await expect
          .poll(async () => ((await hubCall(pair.hub.port, 'machines.list', {})) as { status: string }[])[0]?.status, { timeout: 15_000 })
          .not.toBe('connected')
        relay.drop()
        await expect(page.getByTestId('connection')).toHaveCount(0, { timeout: 15_000 })
      })

      await test.step('the session is still listed, from the mirror, and nothing tried to wake it', async () => {
        await expect(page.getByTestId(`session-row-${s.id}`)).toBeVisible()
        const listed = ((await hubCall(pair.hub.port, 'sessions.list', {})) as { id: string; live: boolean; unreachable?: boolean }[]).find(
          (x) => x.id === s.id,
        )
        expect(listed).toMatchObject({ live: true, unreachable: true })
        await page.waitForTimeout(1500)
        expect(resumes).toEqual([])
      })
    } finally {
      await relay.close()
      await pair.cleanup()
    }
  })
}
