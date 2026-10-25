import { describe, expect, it } from 'vitest'
import { launchPreset } from '../edit-grant.js'
import { presetEnv } from './config.js'

const config = (env: Record<string, string>) => JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null') as unknown

describe("OpenCode's preset, through its inline config", () => {
  it('makes Safe ask for every edit and command, and leaves the other presets to the person’s settings', () => {
    expect(config(presetEnv('safe'))).toEqual({ permission: { edit: 'ask', bash: 'ask' } })
    expect(presetEnv('normal')).toEqual({})
    expect(presetEnv('auto')).toEqual({})
  })

  it('starts Edits as Normal: the two differ only in what the adapter answers, so a switch replaces no process', () => {
    expect(launchPreset('edits')).toBe('normal')
    expect(presetEnv('edits')).toEqual(presetEnv('normal'))
  })

  it('keeps a config the person passes the same way, with Safe’s permissions over theirs', () => {
    const theirs = JSON.stringify({ model: 'their/model', permission: { bash: { 'git *': 'allow' }, webfetch: 'deny' } })
    expect(config(presetEnv('safe', theirs))).toEqual({ model: 'their/model', permission: { bash: 'ask', edit: 'ask', webfetch: 'deny' } })
    expect(config(presetEnv('safe', JSON.stringify({ permission: 'allow' })))).toEqual({ permission: { edit: 'ask', bash: 'ask' } })
    expect(config(presetEnv('safe', 'not json'))).toEqual({ permission: { edit: 'ask', bash: 'ask' } })
  })
})
