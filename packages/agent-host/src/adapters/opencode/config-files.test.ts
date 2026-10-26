import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { readOpenCodeConfigs } from './config-files.js'

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await removeTree(r)
})

function tree(files: Record<string, string>): string {
  const root = tempRoot('cc-opencode-configs-')
  roots.push(root)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

describe("the person's OpenCode configuration a session reads", () => {
  it('finds the agents and rules of every place OpenCode 1.19.4 reads, up to the repository’s root', () => {
    const root = tree({
      'home/.config/opencode/opencode.json': JSON.stringify({ mode: { review: { permission: { bash: 'allow' } } } }),
      'home/.config/opencode/agent/mine.md': '---\nmode: subagent\n---\n',
      'home/.opencode/agents/deep/notes.md': '---\n---\n',
      'repo/.git/HEAD': '',
      'repo/opencode.jsonc': '{\n  // theirs\n  "agent": { "lint": { "permission": "allow", }, },\n  "x": "a // not a comment",\n}\n',
      'repo/sub/.opencode/agent/helper.md': '---\nmode: subagent\npermission:\n  bash: allow\n---\n',
      'repo/sub/.opencode/mode/focus.md': '---\n---\n',
      'repo/sub/.opencode/node_modules/pkg/agent/no.md': '',
      'repo/sub/.opencode/opencode.json': JSON.stringify({ permission: { edit: 'allow' } }),
      'opencode.json': JSON.stringify({ agent: { outside: {} } }),
      'managed/opencode.json': JSON.stringify({ permission: { bash: { 'rm *': 'deny' } } }),
    })
    mkdirSync(join(root, 'repo/sub/work'), { recursive: true })
    const env = { XDG_CONFIG_HOME: join(root, 'home/.config'), OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, 'managed') }
    const found = readOpenCodeConfigs(join(root, 'repo/sub/work'), env, join(root, 'home'))
    expect(found.agentFiles.sort()).toEqual(['deep/notes', 'focus', 'helper', 'mine'])
    expect(found.layers).toEqual(
      expect.arrayContaining([
        { mode: { review: { permission: { bash: 'allow' } } } },
        { agent: { lint: { permission: 'allow' } }, x: 'a // not a comment' },
        { permission: { edit: 'allow' } },
        { permission: { bash: { 'rm *': 'deny' } } },
      ]),
    )
    expect(JSON.stringify(found.layers)).not.toContain('outside')
  })

  it('leaves the project’s own files out where OpenCode is told to, and reads nothing that is not there', () => {
    const root = tree({ 'repo/.git/HEAD': '', 'repo/opencode.json': JSON.stringify({ agent: { lint: {} } }), 'repo/.opencode/agent/helper.md': '' })
    const env = { XDG_CONFIG_HOME: join(root, 'none'), OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, 'none'), OPENCODE_DISABLE_PROJECT_CONFIG: '1' }
    expect(readOpenCodeConfigs(join(root, 'repo'), env, join(root, 'home'))).toEqual({ layers: [], agentFiles: [] })
  })
})
