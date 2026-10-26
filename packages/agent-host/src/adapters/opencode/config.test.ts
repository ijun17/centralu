import { describe, expect, it } from 'vitest'
import { launchPreset } from '../edit-grant.js'
import { NO_CONFIGS, type OpenCodeConfigs, presetEnv } from './config.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * What the person has set up, layer by layer, as OpenCode 1.19.4 reads it before and after Centralu's inline config
 * (`Config.loadInstanceState`, read in its binary): global and project files and `.opencode` folders, then
 * `OPENCODE_CONFIG_CONTENT`, then a managed config
 */
type Setup = { before?: Obj[]; files?: Record<string, Obj>; after?: Obj[]; env?: Record<string, string> }

/** OpenCode's merge (`mergeDeep`): the later object's keys win, a key keeps the place it had first */
function merge(a: unknown, b: unknown): unknown {
  if (!isObj(a) || !isObj(b)) return b
  const out: Obj = { ...a, ...b }
  for (const k of Object.keys(b)) if (k in a && isObj(a[k]) && isObj(b[k])) out[k] = merge(a[k], b[k])
  return out
}

/**
 * OpenCode's permission key and pattern match (`Wildcard.match`, read in its Windows, macOS and Linux builds): `*` and
 * `?`, any case on Windows only (its flags `si` there, `s` elsewhere)
 */
const glob = (platform: Platform, value: string, pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, platform === 'win32' ? 'si' : 's').test(value)

type Rule = { permission: string; pattern: string; action: string }
const rules = (p: unknown): Rule[] =>
  Object.entries(typeof p === 'string' ? { '*': p } : isObj(p) ? p : {}).flatMap(([permission, v]) =>
    typeof v === 'string' ? [{ permission, pattern: '*', action: v }] : Object.entries(isObj(v) ? v : {}).map(([pattern, action]) => ({ permission, pattern, action: String(action) })),
  )

const parsed = (text: string | undefined): Obj => {
  try {
    const v: unknown = JSON.parse(text ?? '{}')
    return isObj(v) ? v : {}
  } catch {
    return {}
  }
}

/** A layer as OpenCode's schema reads it: a permission given as one word is that word for every tool */
const word = (p: unknown) => (typeof p === 'string' ? { '*': p } : p)
const decoded = (layer: Obj): Obj => {
  const each = (group: unknown) => (isObj(group) ? Object.fromEntries(Object.entries(group).map(([k, a]) => [k, isObj(a) && 'permission' in a ? { ...a, permission: word(a.permission) } : a])) : group)
  return { ...layer, ...('permission' in layer ? { permission: word(layer.permission) } : {}), ...('agent' in layer ? { agent: each(layer.agent) } : {}), ...('mode' in layer ? { mode: each(layer.mode) } : {}) }
}

/** What OpenCode puts first under every agent (`Agent.state`), but for a folder outside the project */
const DEFAULTS: Obj = { '*': 'allow', doom_loop: 'ask', read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' } }

/** The rules OpenCode puts under its own agents before the configured ones (`Agent.state`) */
const NATIVE: Record<string, Obj> = {
  build: { question: 'allow', plan_enter: 'allow' },
  plan: { question: 'allow', plan_exit: 'allow', edit: { '*': 'deny' } },
  general: { todowrite: 'deny' },
  explore: { '*': 'deny', grep: 'allow', glob: 'allow', list: 'allow', bash: 'allow', webfetch: 'allow', websearch: 'allow', read: 'allow' },
}

/**
 * What OpenCode 1.19.4 would do for a tool call under an agent, modelled on its binary: every layer merged in order
 * (the inline config after the files, a managed config after it), each `mode` entry copied over its agent last,
 * `OPENCODE_PERMISSION` over the config's `permission`; an agent's rules are the defaults, its native ones, the
 * config's `permission`, then its own, and the last rule that matches decides
 */
function decidesOn(platform: Platform, setup: Setup, env: Record<string, string>, agent: string, tool: string, pattern: string): string {
  const all = { ...setup.env, ...env }
  let s: Obj = {}
  for (const layer of setup.before ?? []) s = merge(s, decoded(layer)) as Obj
  s = merge(s, decoded({ agent: setup.files ?? {} })) as Obj
  s = merge(s, decoded(parsed(all.OPENCODE_CONFIG_CONTENT))) as Obj
  for (const layer of setup.after ?? []) s = merge(s, decoded(layer)) as Obj
  for (const [name, mode] of Object.entries(isObj(s.mode) ? s.mode : {})) s.agent = merge(s.agent ?? {}, { [name]: { ...(mode as Obj), mode: 'primary' } })
  if (all.OPENCODE_PERMISSION) s.permission = merge(s.permission ?? {}, JSON.parse(all.OPENCODE_PERMISSION))
  if (isObj(s.tools)) {
    const fromTools = Object.fromEntries(Object.entries(s.tools).map(([t, on]) => [['write', 'edit', 'patch'].includes(t) ? 'edit' : t, on ? 'allow' : 'deny']))
    s.permission = merge(fromTools, s.permission ?? {})
  }
  const own = isObj(s.agent) && isObj(s.agent[agent]) ? (s.agent[agent]) : {}
  const ruleset = [...rules(DEFAULTS), ...rules(NATIVE[agent] ?? {}), ...rules(s.permission ?? {}), ...rules(own.permission ?? {})]
  return ruleset.findLast((r) => glob(platform, tool, r.permission) && glob(platform, pattern, r.pattern))?.action ?? 'ask'
}

type Platform = 'win32' | 'darwin' | 'linux'
const PLATFORMS: Platform[] = ['win32', 'darwin', 'linux']

/** Each env `envFor` made, with the one it made for each platform */
const perPlatform = new WeakMap<object, Record<Platform, Record<string, string>>>()

/**
 * What OpenCode decides on every platform, with the env Centralu passes there; the platforms' answers when they differ,
 * so no assertion passes on one platform's match alone (#1565 Mac re-check of 4ca7a9fda: keys `BASH` held only on Windows)
 */
function decides(setup: Setup, env: Record<string, string>, agent: string, tool: string, pattern = 'x'): string {
  const envs = perPlatform.get(env)
  const said = PLATFORMS.map((p) => decidesOn(p, setup, envs?.[p] ?? env, agent, tool, pattern))
  return said.every((a) => a === said[0]) ? said[0]! : PLATFORMS.map((p, i) => `${p} ${said[i]}`).join(', ')
}

/** The configs the launch reads, for a setup: every layer, and the agents its files define */
const seen = (setup: Setup): OpenCodeConfigs => ({ layers: [...(setup.before ?? []), ...(setup.after ?? [])], agentFiles: Object.keys(setup.files ?? {}) })
function envFor(preset: Parameters<typeof presetEnv>[0], setup: Setup = {}): Record<string, string> {
  const envs = Object.fromEntries(PLATFORMS.map((p) => [p, presetEnv(preset, setup.env ?? {}, seen(setup), p)])) as Record<Platform, Record<string, string>>
  perPlatform.set(envs.darwin, envs)
  return envs.darwin
}
const inline = (env: Record<string, string>) => JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null') as Obj | null

const SAFE_ASKS = ['edit', 'bash', 'webfetch', 'websearch']
const ALLOW_ALL = { bash: 'allow', edit: 'allow', webfetch: 'allow', websearch: 'allow' }

/**
 * Each change Safe holds, whatever the person's setup allows: the agent Centralu runs (`build`) asks, and every other
 * agent, which only runs as a subagent, where OpenCode drops an ask, is denied
 */
function expectSafe(setup: Setup, agents: string[]) {
  const env = envFor('safe', setup)
  for (const agent of agents) for (const tool of SAFE_ASKS) expect(`${agent} ${tool}: ${decides(setup, env, agent, tool)}`).toBe(`${agent} ${tool}: ${agent === 'build' ? 'ask' : 'deny'}`)
}

describe("OpenCode's Safe, through its inline config", () => {
  it('asks before every edit, command and web fetch under the agent Centralu runs, and denies them under the others', () => {
    expectSafe({}, ['build', 'plan', 'general', 'explore'])
    expect(inline(envFor('safe'))?.default_agent).toBe('build')
  })

  it('still asks where a `mode` entry of the person’s project or global config allows (review of PR 3, cases C and D)', () => {
    expectSafe({ before: [{ mode: { build: { permission: { bash: 'allow', edit: 'allow' } } } }] }, ['build'])
    expectSafe({ before: [{ mode: { build: { permission: ALLOW_ALL }, review: { permission: ALLOW_ALL } } }] }, ['build', 'review'])
  })

  it('makes no agent primary by naming it under `mode`: only the names the person listed there are', () => {
    const env = envFor('safe', { before: [{ mode: { review: {} } }], files: { helper: { mode: 'subagent' } } })
    expect(Object.keys((inline(env)?.mode as Obj | undefined) ?? {})).toEqual(['review'])
  })

  it('still asks under an agent the person defines only in a file, as `task` reaches it (case E)', () => {
    expectSafe({ files: { helper: { mode: 'subagent', permission: { bash: 'allow', edit: 'allow' } } } }, ['helper'])
    expectSafe({ files: { 'team/helper': { permission: 'allow' } } }, ['team/helper'])
  })

  it('asks before handing work to an agent it cannot see (one a plugin adds), and not before one it holds', () => {
    const setup = { files: { helper: { mode: 'subagent' } } }
    const env = envFor('safe', setup)
    for (const agent of ['build', 'general']) {
      // A subagent cannot ask, so it is denied (review of the subagent fix)
      expect(decides(setup, env, agent, 'task', 'unseen')).toBe(agent === 'build' ? 'ask' : 'deny')
      expect(decides(setup, env, agent, 'task', 'helper')).toBe('allow')
      expect(decides(setup, env, agent, 'task', 'explore')).toBe('allow')
    }
  })

  it('still asks where the person’s own rule for a tool comes before a wildcard that allows everything', () => {
    expectSafe({ before: [{ agent: { build: { permission: { bash: 'allow', edit: 'allow', '*': 'allow' } } } }] }, ['build'])
    expectSafe({ before: [{ permission: { bash: 'allow', '*': 'allow' } }] }, ['build', 'general'])
  })

  it('keeps the person’s deny: Safe asks more, never less', () => {
    const setup = { before: [{ permission: { bash: { 'rm *': 'deny' } }, agent: { build: { permission: { webfetch: 'deny' } } } }], after: [{ permission: { edit: { '*.env': 'deny' } } }] }
    const env = envFor('safe', setup)
    expect(decides(setup, env, 'build', 'bash', 'rm -rf x')).toBe('deny')
    expect(decides(setup, env, 'build', 'bash', 'ls')).toBe('ask')
    expect(decides(setup, env, 'build', 'webfetch')).toBe('deny')
    expect(decides(setup, env, 'general', 'edit', 'a.env')).toBe('deny')
    const legacy = { before: [{ tools: { bash: false, write: false } }] }
    expect(decides(legacy, envFor('safe', legacy), 'build', 'bash')).toBe('deny')
    expect(decides(legacy, envFor('safe', legacy), 'build', 'edit')).toBe('deny')
  })

  it('keeps the person’s deny of handing work to other agents, for all of them or for one (second review of PR 3)', () => {
    for (const before of [[{ permission: { task: 'deny' } }], [{ permission: { '*': 'deny', read: 'allow' } }]]) {
      const setup = { before }
      for (const agent of ['general', 'explore']) expect(decides(setup, envFor('safe', setup), 'build', 'task', agent)).toBe('deny')
    }
    const one = { before: [{ permission: { task: { general: 'deny' } } }] }
    expect(decides(one, envFor('safe', one), 'build', 'task', 'general')).toBe('deny')
    expect(decides(one, envFor('safe', one), 'build', 'task', 'explore')).toBe('allow')
  })

  it('keeps a config the person passes the same way, and holds what it allows', () => {
    const theirs = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'their/model', default_agent: 'mine', permission: 'allow', agent: { mine: { permission: ALLOW_ALL, model: 'x/y' } } }) }
    expectSafe({ env: theirs }, ['build', 'mine', 'general'])
    const env = envFor('safe', { env: theirs })
    expect(inline(env)).toMatchObject({ model: 'their/model', default_agent: 'build', agent: { mine: { model: 'x/y' } } })
    expect(inline(presetEnv('safe', { OPENCODE_CONFIG_CONTENT: 'not json' }, NO_CONFIGS))?.permission).toBeTruthy()
  })

  it('still asks where OPENCODE_PERMISSION allows, and keeps the rest of it', () => {
    const setup = { env: { OPENCODE_PERMISSION: JSON.stringify({ ...ALLOW_ALL, doom_loop: 'allow' }) } }
    expectSafe(setup, ['build', 'general', 'explore'])
    expect(JSON.parse(envFor('safe', setup).OPENCODE_PERMISSION ?? '{}')).toMatchObject({ doom_loop: 'allow' })
  })
})

/**
 * Case E of the #1565 Mac re-check, as OpenCode 1.19.4 logged it (its `evaluated` and `asking` lines, 2026-10-25): under
 * Safe, `build` handed work through `task` to the project's `.opencode/agent/helper.md`, a subagent whose own rules allow
 * `bash` and `edit`; in the helper's session OpenCode evaluated `bash` for `echo pwned > marker.txt` and `echo hi` as
 * `ask` and asked, and its ACP side, which knows only the session it opened, sent no `session/request_permission`, so
 * the turn waited until the bound. No ACP frame carries a subagent's calls, so the case is replayed on OpenCode's rules.
 */
const CASE_E: Setup = { files: { helper: { mode: 'subagent', permission: { bash: 'allow', edit: 'allow' } } } }
const CASE_E_CALLS: Array<[string, string, string]> = [
  ['build', 'task', 'helper'],
  ['helper', 'bash', 'echo pwned > marker.txt'],
  ['helper', 'bash', 'echo hi'],
  ['helper', 'edit', 'w.txt'],
]

describe('an ask under a subagent, which OpenCode never sends over ACP', () => {
  it('is a deny in case E, so nothing waits on it; handing the work over still runs', () => {
    const env = envFor('safe', CASE_E)
    expect(CASE_E_CALLS.map(([agent, tool, pattern]) => `${agent} ${tool} ${pattern}: ${decides(CASE_E, env, agent, tool, pattern)}`)).toEqual([
      'build task helper: allow',
      'helper bash echo pwned > marker.txt: deny',
      'helper bash echo hi: deny',
      'helper edit w.txt: deny',
    ])
  })

  it('never asks under any agent but the one Centralu runs: not for OpenCode’s own asks, nor for the person’s', () => {
    const setup: Setup = {
      before: [{ permission: { lsp: 'ask', bash: { 'git *': 'ask' } }, agent: { review: { mode: 'subagent', permission: { webfetch: 'ask', skill: { '*': 'ask' } } } } }],
      files: { helper: { mode: 'subagent' } },
    }
    const calls: Array<[string, string]> = [['edit', 'a.ts'], ['bash', 'git push'], ['bash', 'ls'], ['webfetch', 'x'], ['read', 'a.env'], ['doom_loop', 'x'], ['lsp', 'x'], ['skill', 'x']]
    for (const preset of ['safe', 'normal'] as const) {
      const env = envFor(preset, setup)
      for (const agent of ['plan', 'general', 'explore', 'review', 'helper', 'plugged'])
        for (const [tool, pattern] of calls) expect(`${preset} ${agent} ${tool} ${pattern}: ${decides(setup, env, agent, tool, pattern)}`).not.toMatch(/: ask$/)
      for (const [tool, pattern] of [['read', 'a.env'], ['doom_loop', 'x'], ['lsp', 'x'], ['bash', 'git push']] as const)
        expect(`${preset} build ${tool}: ${decides(setup, env, 'build', tool, pattern)}`).toBe(`${preset} build ${tool}: ask`)
      expect(decides(setup, env, 'build', 'read', 'a.ts')).toBe('allow')
      expect(decides(setup, env, 'explore', 'read', 'a.ts')).toBe('allow')
    }
  })

  it('denies a subagent what the person asks for in `task` and OPENCODE_PERMISSION too (review of the subagent fix)', () => {
    const setup = { before: [{ permission: { task: 'ask' } }], env: { OPENCODE_PERMISSION: JSON.stringify({ bash: 'ask', lsp: 'ask' }) } }
    for (const preset of ['safe', 'normal'] as const) {
      const env = envFor(preset, setup)
      for (const [tool, pattern] of [['task', 'mine'], ['bash', 'ls'], ['lsp', 'x']] as const) {
        expect(`${preset} build ${tool}: ${decides(setup, env, 'build', tool, pattern)}`).toBe(`${preset} build ${tool}: ask`)
        for (const agent of ['general', 'explore']) expect(`${preset} ${agent} ${tool}: ${decides(setup, env, agent, tool, pattern)}`).toBe(`${preset} ${agent} ${tool}: deny`)
      }
    }
  })

  it('never loosens a tool whose name starts as a held one’s, which its key `bash*` also matches (review of the subagent fix)', () => {
    const setup = { before: [{ permission: { read_notes: 'deny', bash_server: 'allow' } }] }
    for (const preset of ['safe', 'normal'] as const) {
      const env = envFor(preset, setup)
      for (const agent of ['build', 'general']) expect(decides(setup, env, agent, 'read_notes')).toBe('deny')
      expect(decides(setup, env, 'build', 'bash_server')).toBe('ask')
      expect(decides(setup, env, 'build', 'bash')).toBe('ask')
    }
  })

  it('never hands work to the agent Centralu runs, as a subagent, where it could not ask', () => {
    const setup = { before: [{ agent: { build: { mode: 'all' } } }] }
    for (const preset of ['safe', 'normal'] as const) expect(decides(setup, envFor(preset, setup), 'general', 'task', 'build')).toBe('deny')
  })
})

describe("OpenCode's Normal and Edits: Centralu's base under the person's own rules", () => {
  it('asks before edits and commands where the person set nothing, as Claude and Codex do; a subagent is denied them', () => {
    const env = envFor('normal')
    for (const agent of ['build', 'general', 'explore'])
      for (const tool of ['edit', 'bash']) expect(`${agent} ${tool}: ${decides({}, env, agent, tool)}`).toBe(`${agent} ${tool}: ${agent === 'build' ? 'ask' : 'deny'}`)
    expect(decides({}, env, 'build', 'webfetch')).toBe('allow')
  })

  it('asks under the agent the person runs by default, and lets their rules for a subagent win but for an ask', () => {
    const setup = { before: [{ default_agent: 'mine', agent: { mine: {}, general: { permission: { bash: 'allow', edit: { '*': 'ask', '*.md': 'allow' } } } } }] }
    const env = envFor('normal', setup)
    expect(decides(setup, env, 'mine', 'bash')).toBe('ask')
    expect(decides(setup, env, 'general', 'bash')).toBe('allow')
    expect(decides(setup, env, 'general', 'edit', 'a.md')).toBe('allow')
    expect(decides(setup, env, 'general', 'edit', 'a.ts')).toBe('deny')
    expect(decides(setup, env, 'build', 'bash')).toBe('deny')
  })

  it('lets the person’s explicit rules win over that base', () => {
    for (const before of [[{ permission: { bash: 'allow' } }], [{ permission: { '*': 'allow' } }], [{ permission: 'allow' }], [{ agent: { build: { permission: { bash: 'allow' } } } }], [{ tools: { bash: true } }]]) {
      const setup = { before }
      expect(`${JSON.stringify(before)}: ${decides(setup, envFor('normal', setup), 'build', 'bash')}`).toBe(`${JSON.stringify(before)}: allow`)
    }
    const partial = { before: [{ permission: { bash: { 'git *': 'allow', 'rm *': 'deny' } } }] }
    expect(decides(partial, envFor('normal', partial), 'build', 'bash', 'git status')).toBe('allow')
    expect(decides(partial, envFor('normal', partial), 'build', 'bash', 'rm -rf x')).toBe('deny')
    expect(decides(partial, envFor('normal', partial), 'build', 'bash', 'curl x')).toBe('ask')
    const theirs = { env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } }
    expect(decides(theirs, envFor('normal', theirs), 'build', 'edit')).toBe('allow')
    expect(decides(theirs, envFor('normal', theirs), 'build', 'bash')).toBe('ask')
  })

  it('starts Edits as Normal: the adapter allows the edits inside the folder itself, and commands ask', () => {
    expect(launchPreset('edits')).toBe('normal')
    expect(envFor('edits')).toEqual(envFor('normal'))
  })

  it('leaves Auto to OpenCode’s own settings: the adapter answers whatever it asks', () => {
    expect(envFor('auto', { before: [{ permission: { bash: 'ask' } }] })).toEqual({})
  })
})
