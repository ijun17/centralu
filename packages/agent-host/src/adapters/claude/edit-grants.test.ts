import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import { fakeClaudeSdk, type CanUseTool } from './claude-sdk-fake.test-helpers.js'
import { answerOrCard } from '../approval-outcome.test-helpers.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * The `edits` preset on Claude (#1525): an edit inside the session's folder needs no card; a command, a delete, a path
 * outside the folder and the places that decide what runs still ask; `normal` and `safe` ask for all of them. The SDK is
 * a fake and `canUseTool` is called directly, as in read-grants.test.ts.
 */
const sdk = vi.hoisted(() => ({ canUseTool: null as CanUseTool | null, modes: [] as unknown[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  // The settings engine is the SDK's own: the ask rules are read the way the CLI reads them
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  ...fakeClaudeSdk((options) => {
    sdk.canUseTool = options.canUseTool ?? null
    sdk.modes.push(options.permissionMode)
  }),
}))

const { ClaudeAdapter } = await import('./index.js')

let base: string
let folder: string
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR
beforeEach(() => {
  base = tempRoot('claude-edits')
  // The person's own ~/.claude (and its ask rules) is not part of these cases
  process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-config')
  folder = join(base, 'proj')
  mkdirSync(join(folder, 'src'), { recursive: true })
  mkdirSync(join(base, 'outside'))
  sdk.modes.length = 0
})
afterEach(() => {
  if (claudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  return removeTree(base)
})

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

describe('the edits grant and a person own rules, and the live preset (#1525)', () => {
  const secretWrite = (): [string, Record<string, unknown>] => ['Write', { file_path: join(folder, 'secret', 'key.txt'), content: 'x' }]
  const plainWrite = (): [string, Record<string, unknown>] => ['Write', { file_path: join(folder, 'src', 'a.ts'), content: 'x' }]

  async function open(preset: PermissionPreset, settings?: unknown) {
    const events: NormalizedEvent[] = []
    if (settings) {
      mkdirSync(join(folder, '.claude'), { recursive: true })
      writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify(settings))
    }
    const handle = await new ClaudeAdapter().createSession({ sessionId: 's1', cwd: folder, permissionPreset: preset, projectTrusted: true }, (e) => events.push(e))
    const asks = () => events.filter((e) => e.type === 'approval_request').length
    const call = async ([name, input]: [string, Record<string, unknown>], options?: Record<string, unknown>) => {
      const r = await answerOrCard(() => sdk.canUseTool!(name, input, options), asks)
      return r === 'still asking' ? 'card' : r.behavior
    }
    return { handle, call }
  }

  it('a person ask rule for an editing tool wins: Write(secret/**) still raises a card under edits', async () => {
    const { handle, call } = await open('edits', { permissions: { ask: ['Write(secret/**)'] } })
    expect(await call(secretWrite())).toBe('card')
    // The rule path pattern is the CLI syntax and is not matched here: any such rule leaves the session without the grant
    expect(await call(plainWrite())).toBe('card')
    await handle.dispose()
  })

  it('an ask rule for another tool leaves the grant alone', async () => {
    const { handle, call } = await open('edits', { permissions: { ask: ['Bash(git push:*)'] } })
    expect(await call(plainWrite())).toBe('allow')
    await handle.dispose()
  })

  it('an ask the CLI says a rule or a safety check forced is a card, with no rule in the settings to read', async () => {
    const { handle, call } = await open('edits')
    expect(await call(plainWrite())).toBe('allow')
    expect(await call(plainWrite(), { matchedAskRule: { source: 'userSettings', toolName: 'Write' } })).toBe('card')
    expect(await call(plainWrite(), { decisionReason: 'Sensitive file: needs manual approval' })).toBe('card')
    await handle.dispose()
  })

  it('the reason text is free text: only none, or the permission mode asking, grants; any other reason, known or not, is a card', async () => {
    const { handle, call } = await open('edits')
    expect(await call(plainWrite(), { decisionReason: '' })).toBe('allow')
    expect(await call(plainWrite(), { decisionReason: 'Current permission mode (Default) requires approval for this Write command' })).toBe('allow')
    for (const reason of ['Reworded: please look at this one', 'Write to a path that needs a human', 'Path is on the deny list', 'ask rule from userSettings']) {
      expect(await call(plainWrite(), { decisionReason: reason }), reason).toBe('card')
    }
    await handle.dispose()
  })

  it('reads the preset live: lowering edits to normal takes effect at once, raising it back too, with no new process', async () => {
    const { handle, call } = await open('edits')
    expect(await call(plainWrite())).toBe('allow')
    handle.setPermissionPreset!('normal')
    expect(await call(plainWrite())).toBe('card')
    handle.setPermissionPreset!('edits')
    expect(await call(plainWrite())).toBe('allow')
    expect(sdk.modes).toHaveLength(1)
    await handle.dispose()
  })

  it('a session launched under normal takes the grant when raised to edits, and one launched under safe does not until it restarts', async () => {
    const normal = await open('normal')
    normal.handle.setPermissionPreset!('edits')
    expect(await normal.call(plainWrite())).toBe('allow')
    await normal.handle.dispose()
    const safe = await open('safe')
    safe.handle.setPermissionPreset!('edits')
    expect(await safe.call(plainWrite())).toBe('card')
    await safe.handle.dispose()
  })
})
