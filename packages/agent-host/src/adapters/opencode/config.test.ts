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

/** OpenCode's permission key and pattern match (`Wildcard.match`): `*` and `?`, any case */
const glob = (value: string, pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'si').test(value)

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
function decides(setup: Setup, env: Record<string, string>, agent: string, tool: string, pattern = 'x'): string {
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
  const own = isObj(s.agent) && isObj(s.agent[agent]) ? (s.agent[agent] as Obj) : {}
  const ruleset = [...rules({ '*': 'allow' }), ...rules(NATIVE[agent] ?? {}), ...rules(s.permission ?? {}), ...rules(own.permission ?? {})]
  return ruleset.findLast((r) => glob(tool, r.permission) && glob(pattern, r.pattern))?.action ?? 'ask'
}

/** The configs the launch reads, for a setup: every layer, and the agents its files define */
const seen = (setup: Setup): OpenCodeConfigs => ({ layers: [...(setup.before ?? []), ...(setup.after ?? [])], agentFiles: Object.keys(setup.files ?? {}) })
const envFor = (preset: Parameters<typeof presetEnv>[0], setup: Setup = {}) => presetEnv(preset, setup.env ?? {}, seen(setup))
const inline = (env: Record<string, string>) => JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null') as Obj | null

const SAFE_ASKS = ['edit', 'bash', 'webfetch', 'websearch']
const ALLOW_ALL = { bash: 'allow', edit: 'allow', webfetch: 'allow', websearch: 'allow' }

/** Every agent asks before each change Safe holds, whatever the person's setup allows */
function expectSafe(setup: Setup, agents: string[]) {
  const env = envFor('safe', setup)
  for (const agent of agents) for (const tool of SAFE_ASKS) expect(`${agent} ${tool}: ${decides(setup, env, agent, tool)}`).toBe(`${agent} ${tool}: ask`)
}

describe("OpenCode's Safe, through its inline config", () => {
  it('asks before every edit, command and web fetch under each of its own agents', () => {
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
      expect(decides(setup, env, agent, 'task', 'unseen')).toBe('ask')
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

describe("OpenCode's Normal and Edits: Centralu's base under the person's own rules", () => {
  it('asks before edits and commands where the person set nothing, as Claude and Codex do', () => {
    const env = envFor('normal')
    for (const agent of ['build', 'general', 'explore']) for (const tool of ['edit', 'bash']) expect(`${agent} ${tool}: ${decides({}, env, agent, tool)}`).toBe(`${agent} ${tool}: ask`)
    expect(decides({}, env, 'build', 'webfetch')).toBe('allow')
  })

  it('lets the person’s explicit rules win over that base', () => {
    for (const before of [[{ permission: { bash: 'allow' } }], [{ permission: { '*': 'allow' } }], [{ permission: 'allow' }], [{ agent: { build: { permission: { bash: 'allow' } } } }], [{ tools: { bash: true } }]]) {
      const setup = { before }
      expect(`${JSON.stringify(before)}: ${decides(setup, envFor('normal', setup), 'build', 'bash')}`).toBe(`${JSON.stringify(before)}: allow`)
    }
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
