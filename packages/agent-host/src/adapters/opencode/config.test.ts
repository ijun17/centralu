import { describe, expect, it } from 'vitest'
import { launchPreset } from '../edit-grant.js'
import { presetEnv } from './config.js'

type Perm = Record<string, unknown>
type Config = { permission?: Perm; agent?: Record<string, { permission?: Perm }>; default_agent?: string; model?: string }
const config = (env: Record<string, string>) => JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null') as Config | null

/**
 * What OpenCode 1.19.4 would ask under an agent, read from its binary: the config's `permission`, then
 * `OPENCODE_PERMISSION` over it, then the agent's own `permission` over both (the last word wins)
 */
function asks(env: Record<string, string>, agent: string, tool: 'edit' | 'bash'): unknown {
  const c = config(env) ?? {}
  const fromEnv = JSON.parse(env.OPENCODE_PERMISSION ?? '{}') as Perm
  return { ...c.permission, ...fromEnv, ...c.agent?.[agent]?.permission }[tool]
}

describe("OpenCode's preset, through its inline config", () => {
  it('makes Safe ask for every edit and command, and leaves the other presets to the person’s settings', () => {
    for (const agent of ['build', 'plan', 'general', 'explore']) for (const tool of ['edit', 'bash'] as const) expect(asks(presetEnv('safe'), agent, tool)).toBe('ask')
    expect(config(presetEnv('safe'))?.default_agent).toBe('build')
    expect(presetEnv('normal')).toEqual({})
    expect(presetEnv('auto')).toEqual({})
  })

  it('starts Edits as Normal: the two differ only in what the adapter answers, so a switch replaces no process', () => {
    expect(launchPreset('edits')).toBe('normal')
    expect(presetEnv('edits')).toEqual(presetEnv('normal'))
  })

  it('keeps a config the person passes the same way, with Safe’s permissions over theirs', () => {
    const theirs = JSON.stringify({ model: 'their/model', permission: { bash: { 'git *': 'allow' }, webfetch: 'deny' } })
    expect(config(presetEnv('safe', { OPENCODE_CONFIG_CONTENT: theirs }))).toMatchObject({ model: 'their/model', permission: { bash: 'ask', edit: 'ask', webfetch: 'deny' } })
    expect(config(presetEnv('safe', { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: 'allow' }) }))?.permission).toEqual({ edit: 'ask', bash: 'ask' })
    expect(config(presetEnv('safe', { OPENCODE_CONFIG_CONTENT: 'not json' }))?.permission).toEqual({ edit: 'ask', bash: 'ask' })
  })

  it('still asks under Safe where the person’s own settings allow through an agent or OPENCODE_PERMISSION (review of PR 3)', () => {
    const theirs = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: 'mine', agent: { build: { permission: { bash: 'allow' } }, mine: { permission: { edit: 'allow', bash: 'allow' }, model: 'x/y' } } }),
      OPENCODE_PERMISSION: JSON.stringify({ bash: 'allow', webfetch: 'deny' }),
    }
    const env = presetEnv('safe', theirs)
    for (const agent of ['build', 'mine', 'general']) for (const tool of ['edit', 'bash'] as const) expect(asks(env, agent, tool)).toBe('ask')
    expect(config(env)?.default_agent).toBe('build')
    expect(config(env)?.agent?.mine).toMatchObject({ model: 'x/y' })
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? '{}')).toEqual({ bash: 'ask', edit: 'ask', webfetch: 'deny' })
  })
})
