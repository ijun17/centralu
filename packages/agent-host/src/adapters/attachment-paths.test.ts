import { describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@cc/protocol'
import { fakeClaudeSdkWire } from './claude/claude-sdk-fake.test-helpers.js'
import { withAttachmentPaths } from './contract.js'

/**
 * What Claude Code and Codex are given for a message with attachments: the text, a blank line, then one `@<path>` line per
 * file, which each CLI resolves itself. The host hands the files apart from the text (`SessionHandle.send`'s `attachments`),
 * and the words the CLIs read stay these.
 */
const wire = vi.hoisted(() => ({ claude: [] as Record<string, unknown>[], codex: [] as { method: string; params: Record<string, unknown> | undefined }[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => fakeClaudeSdkWire(wire.claude))
vi.mock('./codex/client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      wire.codex.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { ClaudeAdapter } = await import('./claude/index.js')
const { CodexAdapter } = await import('./codex/index.js')

const FILES: Attachment[] = [
  { kind: 'image', path: 'shots/one.png', name: 'one.png', mime: 'image/png' },
  { kind: 'file', path: '/data/attachments/s1/notes v2.md', name: 'notes v2.md' },
]
const SENT = 'Look at these\n\n@shots/one.png\n@/data/attachments/s1/notes v2.md'

/** Resolves once `pick` holds of what was written: polled at the end of each task, as the CLI fakes say nothing back */
async function until(pick: () => boolean): Promise<void> {
  while (!pick()) await new Promise((r) => setImmediate(r))
}

describe('attachments named by path', () => {
  it('are the text, a blank line, and one @ line per file in order; no attachments leave the text as it is', () => {
    expect(withAttachmentPaths('Look at these', FILES)).toBe(SENT)
    expect(withAttachmentPaths('Look at these', [])).toBe('Look at these')
    expect(withAttachmentPaths('Look at these', undefined)).toBe('Look at these')
  })

  it('are what Claude Code reads, for a send and for a tracked send', async () => {
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'att-claude', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    handle.send('Look at these', { origin: { kind: 'human' }, attachments: FILES })
    void handle.sendTracked?.('Look at these', undefined, { attachments: FILES }).catch(() => {})
    await until(() => wire.claude.length === 2)
    expect(wire.claude.map((m) => (m.message as { content: { text: string }[] }).content[0]!.text)).toEqual([SENT, SENT])
    await handle.dispose()
  })

  it('are what Codex reads in its turn, for a send and for a tracked send', async () => {
    const turns = () => wire.codex.filter((r) => r.method === 'turn/start')
    const handle = await new CodexAdapter().createSession({ sessionId: 'att-codex', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    handle.send('Look at these', { attachments: FILES })
    await until(() => turns().length === 1)
    void handle.sendTracked?.('Look at these', undefined, { attachments: FILES }).catch(() => {})
    await until(() => turns().length === 2)
    expect(turns().map((r) => r.params?.input)).toEqual([[{ type: 'text', text: SENT }], [{ type: 'text', text: SENT }]])
    await handle.dispose()
  })
})
