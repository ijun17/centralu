import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import { answerOrCard } from '../approval-outcome.test-helpers.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * The `edits` preset on Claude (#1525): an edit inside the session's folder needs no card; a command, a delete, a path
 * outside the folder and the places that decide what runs still ask; `normal` and `safe` ask for all of them. The SDK is
 * a fake and `canUseTool` is called directly, as in read-grants.test.ts.
 */
type CanUseTool = (name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>
const sdk = vi.hoisted(() => ({ canUseTool: null as CanUseTool | null, modes: [] as unknown[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { canUseTool?: CanUseTool; permissionMode?: unknown } }) => {
    sdk.canUseTool = options.canUseTool ?? null
    sdk.modes.push(options.permissionMode)
    return {
      // eslint-disable-next-line require-yield -- a stream where the CLI says nothing; this test only calls the callback
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

let base: string
let folder: string
beforeEach(() => {
  base = tempRoot('claude-edits')
  folder = join(base, 'proj')
  mkdirSync(join(folder, 'src'), { recursive: true })
  mkdirSync(join(base, 'outside'))
  sdk.modes.length = 0
})
afterEach(() => removeTree(base))

async function askedUnder(preset: PermissionPreset, calls: [string, Record<string, unknown>][]): Promise<string[]> {
  const events: NormalizedEvent[] = []
  const handle = await new ClaudeAdapter().createSession({ sessionId: 's1', cwd: folder, permissionPreset: preset, noSettingFiles: true }, (e) => events.push(e))
  const asks = () => events.filter((e) => e.type === 'approval_request').length
  const out: string[] = []
  for (const [name, input] of calls) {
    const r = await answerOrCard(() => sdk.canUseTool!(name, input), asks)
    out.push(r === 'still asking' ? 'card' : r.behavior)
  }
  await handle.dispose()
  return out
}

describe('the edits preset, Claude (#1525)', () => {
  const calls = (): [string, Record<string, unknown>][] => [
    ['Edit', { file_path: join(folder, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }], // in the folder
    ['Write', { file_path: join(folder, 'src', 'new.ts'), content: 'x' }], // a new file in the folder
    ['MultiEdit', { file_path: join(folder, 'src', 'a.ts'), edits: [] }],
    ['Write', { file_path: join(base, 'outside', 'x.ts'), content: 'x' }], // outside the folder
    ['Edit', { file_path: join(folder, '..', 'outside', 'x.ts'), old_string: 'a', new_string: 'b' }], // out through `..`
    ['Write', { file_path: join(folder, '.git', 'hooks', 'pre-commit'), content: 'x' }], // decides what runs
    ['Write', { file_path: join(folder, '.claude', 'settings.json'), content: '{}' }],
    ['Bash', { command: 'rm -rf src' }], // a delete
    ['Bash', { command: 'npm test' }], // a command
  ]

  it('lets the edits inside the folder through and asks about everything else', async () => {
    expect(await askedUnder('edits', calls())).toEqual(['allow', 'allow', 'allow', 'card', 'card', 'card', 'card', 'card', 'card'])
  })

  it('normal asks for every one of them: an explicit normal keeps its meaning', async () => {
    expect(await askedUnder('normal', calls())).toEqual(Array(9).fill('card'))
  })

  it('safe asks for every one of them', async () => {
    expect(await askedUnder('safe', calls())).toEqual(Array(9).fill('card'))
  })

  it('asks for a link inside the folder that leads out of it', async () => {
    symlinkSync(join(base, 'outside'), join(folder, 'link'), 'junction')
    expect(await askedUnder('edits', [['Write', { file_path: join(folder, 'link', 'x.ts'), content: 'x' }]])).toEqual(['card'])
  })

  it('launches as normal does: the same permission mode, so the grant adds nothing else', async () => {
    await askedUnder('normal', [])
    await askedUnder('edits', [])
    expect(sdk.modes).toEqual(['default', 'default'])
    expect(sdk.modes).not.toContain('acceptEdits') // that mode also approves rm, mv and sed in the folder
  })
})
