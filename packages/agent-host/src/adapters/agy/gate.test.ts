import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { pathsOf } from '../../os.js'
import { realPathOf } from '../edit-grant.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { parseRule } from './deny-rules.js'
import { AgyGate, DECLINED, STOPPED, stopTurn } from './gate.js'

/**
 * The host's end of the agy gate (docs/plans/antigravity-adapter.md §5): a `PreToolUse` hook call in, a decision out.
 * The hook input's shape is the measured one (`{conversationId, stepIdx, toolCall: {name, args}, workspacePaths}`).
 */

const host = pathsOf()
const join = (...parts: string[]) => host.join(...parts)
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTree))
})

function setup(preset: PermissionPreset, extra: Partial<ConstructorParameters<typeof AgyGate>[0]> = {}) {
  const [cwd, pluginRoot, outside] = ['agy-gate-cwd-', 'agy-gate-plugin-', 'agy-gate-out-'].map((prefix) => tempRoot(prefix)) as [string, string, string]
  dirs.push(cwd, pluginRoot, outside)
  const events: NormalizedEvent[] = []
  const gate = new AgyGate({ sessionId: 's-1', cwd, pluginRoot, preset, emit: (e) => events.push(e), ...extra })
  const cards = () => events.filter((e): e is Extract<NormalizedEvent, { type: 'approval_request' }> => e.type === 'approval_request')
  return { cwd, pluginRoot, outside, gate, events, cards }
}

const hook = (name: string, args: Record<string, unknown>) => ({ conversationId: 'c', stepIdx: 3, toolCall: { name, args }, workspacePaths: [] })
const run = (cmd: string) => hook('run_command', { CommandLine: cmd, toolSummary: 'run it' })
const view = (path: string) => hook('view_file', { AbsolutePath: path })
const write = (path: string) => hook('write_to_file', { TargetFile: path, CodeContent: 'x' })
const mcp = (server: string) => hook('call_mcp_tool', { ServerName: server, ToolName: 't', Arguments: {} })

/** The answer if it comes without a card, or 'card' when one was raised (and is left open): whichever happens first */
async function outcome(s: ReturnType<typeof setup>, input: unknown): Promise<string> {
  const before = s.cards().length
  let raised: () => void = () => {}
  const card = new Promise<string>((r) => (raised = () => r('card')))
  const emit = s.events.push.bind(s.events)
  s.events.push = (...e: NormalizedEvent[]) => {
    const n = emit(...e)
    if (s.cards().length > before) raised()
    return n
  }
  try {
    return await Promise.race([s.gate.answer(input).then((a) => a.decision), card])
  } finally {
    s.events.push = emit
  }
}

describe('the presets', () => {
  it('auto allows every known tool without a card', async () => {
    const s = setup('auto')
    expect(await outcome(s, run('rm -rf build'))).toBe('allow')
    expect(await outcome(s, write(join(s.outside, 'a')))).toBe('allow')
    expect(await outcome(s, mcp('someone_else'))).toBe('allow')
  })

  it('normal allows reads inside the folder and asks for edits, commands, other servers and reads outside', async () => {
    const s = setup('normal')
    expect(await outcome(s, view(join(s.cwd, 'a.ts')))).toBe('allow')
    expect(await outcome(s, hook('grep_search', { SearchPath: s.cwd, Query: 'x' }))).toBe('allow')
    expect(await outcome(s, write(join(s.cwd, 'a.ts')))).toBe('card')
    expect(await outcome(s, run('ls'))).toBe('card')
    expect(await outcome(s, mcp('other_server'))).toBe('card')
    expect(await outcome(s, view(join(s.outside, 'a')))).toBe('card')
    expect(await outcome(s, hook('read_url_content', { Url: 'https://example.com' }))).toBe('card')
  })

  it('normal reads a readable folder and a path given later; safe does not', async () => {
    const other = tempRoot('agy-gate-other-')
    dirs.push(other)
    const given = join(other, '..', 'given-elsewhere.txt')
    for (const preset of ['normal', 'safe'] as const) {
      const s = setup(preset, { readableDirs: [other], mayRead: (p) => p === given })
      const expected = preset === 'normal' ? 'allow' : 'card'
      expect(await outcome(s, view(join(other, 'a'))), preset).toBe(expected)
      expect(await outcome(s, view(given)), preset).toBe(expected)
    }
  })

  it('edits allows an edit inside the folder, and still asks for one outside it or in .git', async () => {
    const s = setup('edits')
    expect(await outcome(s, write(join(s.cwd, 'src', 'a.ts')))).toBe('allow')
    expect(await outcome(s, write(join(s.outside, 'a.ts')))).toBe('card')
    expect(await outcome(s, write(join(s.cwd, '.git', 'config')))).toBe('card')
    expect(await outcome(s, run('ls'))).toBe('card')
  })

  it('safe asks for everything but reads inside the folder, a sub-agent included', async () => {
    const s = setup('safe')
    expect(await outcome(s, view(join(s.cwd, 'a')))).toBe('allow')
    expect(await outcome(s, hook('invoke_subagent', { Prompt: 'p', Role: 'r' }))).toBe('card')
    expect(await outcome(setup('normal'), hook('invoke_subagent', { Prompt: 'p', Role: 'r' }))).toBe('allow')
  })

  it('a read through a link out of the folder is not a read inside it', async () => {
    // `cwd/out` is a link to the folder outside: the real resolution is `edit-grant.ts`'s, the link's target given here
    const base = setup('safe')
    const realPath = (p: string) => (p.startsWith(join(base.cwd, 'out')) ? Promise.resolve(p.replace(join(base.cwd, 'out'), base.outside)) : realPathOf(p))
    const s = setup('safe', { cwd: base.cwd, realPath })
    expect(await outcome(s, view(join(base.cwd, 'out', 'secret')))).toBe('card')
    expect(await outcome(s, view(join(base.cwd, 'in', 'file')))).toBe('allow')
  })

  it('a preset change reaches the next call', async () => {
    const s = setup('safe')
    expect(await outcome(s, run('ls'))).toBe('card')
    s.gate.setPermissionPreset('auto')
    expect(await outcome(s, run('ls'))).toBe('allow')
  })
})

describe('what holds under every preset', () => {
  it('a tool tool-kinds.ts does not know is a card, under auto too', async () => {
    for (const preset of ['auto', 'normal'] as const) expect(await outcome(setup(preset), hook('brand_new_tool', { X: 1 })), preset).toBe('card')
  })

  it("Centralu's own MCP server is allowed, under safe too", async () => {
    expect(await outcome(setup('safe'), mcp('centralu_centralu'))).toBe('allow')
  })

  it("a read of agy's MCP tool descriptors is allowed under safe, and only inside that folder", async () => {
    const descriptors = tempRoot('agy-gate-mcp-')
    dirs.push(descriptors)
    const s = setup('safe', { mcpDescriptors: descriptors })
    expect(await outcome(s, hook('read_file', { Path: join(descriptors, 'centralu_centralu', 'ping.json') }))).toBe('allow')
    expect(await outcome(s, hook('read_file', { Path: join(descriptors, '..', 'settings.json') }))).toBe('card')
    expect(await outcome(setup('safe'), hook('read_file', { Path: join(descriptors, 'centralu_centralu', 'ping.json') }))).toBe('card')
  })

  it('a path agy might expand is a card under every preset, never checked as written', async () => {
    for (const preset of ['auto', 'safe'] as const) {
      for (const Path of ['~/.ssh/id_rsa', '$HOME/.ssh/id_rsa', '%USERPROFILE%\\x', 'file:///etc/passwd']) {
        expect(await outcome(setup(preset), hook('read_file', { Path })), `${preset} ${Path}`).toBe('card')
      }
    }
  })

  it('edits does not grant sed_file, whose sed script can run a command', async () => {
    const s = setup('edits')
    expect(await outcome(s, hook('sed_file', { TargetFile: join(s.cwd, 'a.ts'), Expressions: ['1e touch x'] }))).toBe('card')
    expect(await outcome(s, hook('replace_file_content', { TargetFile: join(s.cwd, 'a.ts') }))).toBe('allow')
  })

  it('a write into the plugin root is refused through .. and relative to it, under edits too', async () => {
    const s = setup('edits', { cwd: tempRoot('agy-gate-cwd2-') })
    dirs.push(s.cwd)
    const viaDots = join(s.cwd, '..', s.pluginRoot.split('/').pop() ?? '', 'hooks.json')
    expect(await s.gate.answer(write(viaDots))).toMatchObject({ decision: 'deny' })
  })

  it('a write into the plugin root is refused, under auto too, by any tool that names the path', async () => {
    const s = setup('auto')
    const hooks = join(s.pluginRoot, '.agents', 'plugins', 'centralu', 'hooks.json')
    const a = await s.gate.answer(write(hooks))
    expect(a).toMatchObject({ decision: 'deny' })
    expect(await s.gate.answer(hook('brand_new_tool', { Path: hooks }))).toMatchObject({ decision: 'deny' })
    expect(s.cards()).toHaveLength(0)
  })

  it("the person's deny rule refuses before any allow, under auto too, and names the rule", async () => {
    const denyRules = [parseRule('command(git push)')!]
    const s = setup('auto', { denyRules })
    const a = await s.gate.answer(run('git status && git push --force'))
    expect(a).toEqual({ decision: 'deny', reason: "A deny rule in the person's agy settings blocks this call: command(git push)" })
    expect(await outcome(s, run('git status'))).toBe('allow')
  })

  it("the person's rules never allow: with none matching, normal still asks", async () => {
    expect(await outcome(setup('normal', { denyRules: [parseRule('command(rm)')!] }), run('ls'))).toBe('card')
  })

  it('a hook input it cannot read is refused', async () => {
    const s = setup('auto')
    expect(await s.gate.answer({})).toMatchObject({ decision: 'deny' })
    expect(await s.gate.answer('not json')).toMatchObject({ decision: 'deny' })
  })
})

describe('cards', () => {
  it('a card is a command card with the command, and allow and deny answer the hook', async () => {
    const s = setup('normal')
    const first = s.gate.answer(run('npm test'))
    await expect.poll(() => s.cards().length).toBe(1)
    expect(s.cards()[0]!.detail).toEqual({ kind: 'command', command: 'npm test', cwd: s.cwd })
    expect(s.gate.respondApproval(s.cards()[0]!.requestId, 'allow')).toBe(true)
    expect(await first).toEqual({ decision: 'allow' })
    const second = s.gate.answer(run('npm test'))
    await expect.poll(() => s.cards().length).toBe(2)
    s.gate.respondApproval(s.cards()[1]!.requestId, 'deny')
    expect(await second).toEqual({ decision: 'deny', reason: DECLINED })
    expect(s.gate.respondApproval(s.cards()[1]!.requestId, 'allow')).toBe(false)
  })

  it('a saved rule for one file never allows an edit over several', async () => {
    const s = setup('normal')
    s.gate.applyRules([join(s.cwd, 'a.ts')])
    expect(await outcome(s, hook('multi_replace_file_content', { Path: join(s.cwd, 'a.ts'), TargetFile: join(s.cwd, 'b.ts') }))).toBe('card')
  })

  it('input sent to a running command shows on its card', async () => {
    const s = setup('normal')
    void s.gate.answer(hook('send_command_input', { CommandId: 'c1', Input: 'yes' }))
    await expect.poll(() => s.cards().length).toBe(1)
    expect(s.cards()[0]!.detail).toMatchObject({ kind: 'command', command: 'yes', stdin: true })
  })

  it('"always" with its matcher allows the same command later without a card, and a saved rule does too', async () => {
    const s = setup('normal')
    const first = s.gate.answer(run('npm test'))
    await expect.poll(() => s.cards().length).toBe(1)
    s.gate.respondApproval(s.cards()[0]!.requestId, 'always', 'session', 'npm test')
    expect(await first).toEqual({ decision: 'allow' })
    expect(await outcome(s, run('npm test'))).toBe('allow')
    expect(await outcome(s, run('npm test --watch'))).toBe('card')
    const t = setup('safe')
    t.gate.applyRules([join(t.cwd, 'a.ts')])
    expect(await outcome(t, write(join(t.cwd, 'a.ts')))).toBe('allow')
  })

  it('an edit card names the file and its new text', async () => {
    const s = setup('normal')
    void s.gate.answer(write(join(s.cwd, 'a.ts')))
    await expect.poll(() => s.cards().length).toBe(1)
    expect(s.cards()[0]!.detail).toMatchObject({ kind: 'file_edit', path: join(s.cwd, 'a.ts'), diffPreview: 'x' })
  })

  it('a hook that goes away closes its card', async () => {
    const s = setup('normal')
    const ac = new AbortController()
    const a = s.gate.answer(run('ls'), ac.signal)
    await expect.poll(() => s.cards().length).toBe(1)
    ac.abort()
    expect(await a).toEqual({ decision: 'deny', reason: STOPPED })
    expect(s.events.at(-1)).toMatchObject({ type: 'approval_resolved', decision: 'deny' })
    expect(s.gate.open).toBe(0)
  })
})

describe('Stop', () => {
  it('a call decided after a Stop and the next turn began is refused all the same', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    const realPath = async (p: string) => (await held, realPathOf(p))
    const s = setup('auto', { realPath })
    const a = s.gate.answer(run('rm -rf build'))
    s.gate.stop()
    s.gate.resume()
    release()
    expect(await a).toEqual({ decision: 'deny', reason: STOPPED })
    expect(await s.gate.answer(run('ls'))).toEqual({ decision: 'allow' })
  })


  it('denies every open request before the interrupt is sent, and refuses calls until the next turn', async () => {
    const s = setup('normal')
    const a = s.gate.answer(run('one'))
    const b = s.gate.answer(run('two'))
    await expect.poll(() => s.cards().length).toBe(2)
    const order: string[] = []
    void a.then(() => order.push('a answered'))
    void b.then(() => order.push('b answered'))
    let openAtInterrupt = -1
    stopTurn(s.gate, () => {
      openAtInterrupt = s.gate.open
      order.push('interrupt')
    })
    expect(openAtInterrupt).toBe(0)
    expect(await a).toEqual({ decision: 'deny', reason: STOPPED })
    expect(await b).toEqual({ decision: 'deny', reason: STOPPED })
    expect(s.events.filter((e) => e.type === 'approval_resolved')).toHaveLength(2)
    // A call the stopping turn still makes is refused at once, even one auto would allow
    s.gate.setPermissionPreset('auto')
    expect(await s.gate.answer(run('three'))).toEqual({ decision: 'deny', reason: STOPPED })
    s.gate.resume()
    expect(await s.gate.answer(run('four'))).toEqual({ decision: 'allow' })
  })
})
