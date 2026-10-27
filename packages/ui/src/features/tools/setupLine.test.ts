import { describe, expect, it } from 'vitest'
import type { ToolSetup, ToolStatus } from '@cc/protocol/client'
import { setupOf, setupStates, setupView, signedOutTools, verifyUriOf, withLiveSetups } from './setupLine.js'

const managed = (over: Partial<ToolSetup>): ToolSetup => ({ state: 'ready', install: 'centralu', signIn: 'centralu', ...over })
const status = (name: string, installed: boolean, loggedIn: boolean, setup?: ToolSetup): ToolStatus => ({
  name,
  label: name,
  mark: name.slice(0, 1).toUpperCase(),
  install: 'npm i -g x',
  login: `${name} login`,
  installed,
  loggedIn,
  detail: '',
  ...(setup ? { setup } : {}),
})

describe('setupView: what a tool\'s line says', () => {
  it('a tool that is ready, or whose sign-in cannot be told, has no line', () => {
    expect(setupView(managed({ state: 'ready' }), false)).toEqual({ kind: 'ready' })
    expect(setupView({ state: 'unknown', install: 'terminal', signIn: 'none' }, false)).toEqual({ kind: 'ready' })
  })

  it('a tool that signs in nowhere is never asked to', () => {
    expect(setupView({ state: 'signed_out', install: 'terminal', signIn: 'none' }, false)).toEqual({ kind: 'ready' })
  })

  it('Claude, Codex and Cursor keep their terminal hints', () => {
    expect(setupView({ state: 'signed_out', install: 'terminal', signIn: 'terminal' }, false).kind).toBe('terminal_login')
    expect(setupView({ state: 'not_installed', install: 'terminal', signIn: 'terminal' }, false).kind).toBe('terminal_install')
  })

  it('not installed offers Install; installing shows progress; a failure shows why with Retry; a cancel is not a failure', () => {
    expect(setupView(managed({ state: 'not_installed' }), false)).toEqual({ kind: 'install' })
    expect(setupView(managed({ state: 'installing', progress: { received: 5, total: 10 } }), false)).toEqual({ kind: 'installing', received: 5, total: 10 })
    expect(setupView(managed({ state: 'installing' }), false)).toEqual({ kind: 'installing', received: 0, total: null })
    expect(setupView(managed({ state: 'not_installed', failure: { reason: 'checksum', message: 'bad file' } }), false)).toEqual({ kind: 'install_failed', message: 'bad file' })
    expect(setupView(managed({ state: 'not_installed', failure: { reason: 'cancelled', message: 'x' } }), false)).toEqual({ kind: 'install' })
  })

  it('a system Google ships no build for has nothing to press', () => {
    expect(setupView(managed({ state: 'not_installed', failure: { reason: 'unsupported_platform', message: 'no build' } }), false)).toEqual({ kind: 'unsupported', message: 'no build' })
  })

  it('signed out offers Sign in; signing in waits; a timeout and a failure offer it again; a cancel does not apologise', () => {
    expect(setupView(managed({ state: 'signed_out' }), false)).toEqual({ kind: 'sign_in' })
    expect(setupView(managed({ state: 'signing_in' }), false)).toEqual({ kind: 'signing_in' })
    expect(setupView(managed({ state: 'signed_out', failure: { reason: 'timed_out', message: 't' } }), false)).toEqual({ kind: 'sign_in_failed', reason: 'timed_out', message: 't' })
    expect(setupView(managed({ state: 'signed_out', failure: { reason: 'failed', message: 'f' } }), false)).toEqual({ kind: 'sign_in_failed', reason: 'failed', message: 'f' })
    expect(setupView(managed({ state: 'signed_out', failure: { reason: 'cancelled', message: 'c' } }), false)).toEqual({ kind: 'sign_in' })
  })

  it('a linked machine only says where to sign in: no button', () => {
    expect(setupView(managed({ state: 'signed_out' }), true)).toEqual({ kind: 'sign_in_elsewhere' })
    expect(setupView(managed({ state: 'signed_out', failure: { reason: 'timed_out', message: 't' } }), true)).toEqual({ kind: 'sign_in_elsewhere' })
  })

  it('a sign-in running on a linked machine is its own: no Cancel here, the same sentence as when signed out', () => {
    expect(setupView(managed({ state: 'signing_in' }), true)).toEqual({ kind: 'sign_in_elsewhere' })
  })

  it('an account that is not eligible carries Google\'s verification address, and only an https one', () => {
    const ineligible = (verifyUri?: string) => managed({ state: 'signed_out', failure: { reason: 'ineligible', message: 'no', ...(verifyUri ? { verifyUri } : {}) } })
    expect(setupView(ineligible('https://accounts.google.com/verify'), false)).toEqual({ kind: 'ineligible', verifyUri: 'https://accounts.google.com/verify' })
    expect(setupView(ineligible(), false)).toEqual({ kind: 'ineligible', verifyUri: null })
    expect(verifyUriOf(ineligible('http://evil.example'))).toBeNull()
    expect(verifyUriOf(ineligible('javascript:alert(1)'))).toBeNull()
  })
})

describe('setupOf: which setup counts', () => {
  const s = status('antigravity', true, false, managed({ state: 'signed_out' }))
  it('this computer\'s live setup wins over the detection', () => {
    expect(setupOf(s, managed({ state: 'ready' }), false).state).toBe('ready')
  })
  it('a linked machine ignores this computer\'s live setup', () => {
    expect(setupOf(s, managed({ state: 'ready' }), true).state).toBe('signed_out')
  })
  it('a host that predates the setup is read from the two booleans', () => {
    expect(setupOf(status('claude', true, false), undefined, false).state).toBe('signed_out')
    expect(setupOf(status('claude', false, false), undefined, false).state).toBe('not_installed')
  })
})

describe('withLiveSetups: a setup that moved after the list was read', () => {
  it('a sign-in that succeeded makes the tool usable without asking again', () => {
    const list = [status('antigravity', true, false, managed({ state: 'signed_out' })), status('claude', true, true)]
    const out = withLiveSetups(list, { antigravity: managed({ state: 'ready' }) })
    expect(out[0]).toMatchObject({ installed: true, loggedIn: true })
    expect(out[1]).toBe(list[1])
  })
  it('an install that runs is not installed yet', () => {
    const out = withLiveSetups([status('antigravity', false, false)], { antigravity: managed({ state: 'installing' }) })
    expect(out[0]).toMatchObject({ installed: false, loggedIn: false })
  })
})

describe('signedOutTools: which tools get an signed-out donut', () => {
  it('every tool that is installed but signed out, and not one that is missing, ready, or cannot tell', () => {
    const list = [
      status('claude', true, false),
      status('codex', true, true),
      status('cursor-agent', false, false),
      status('antigravity', true, false, managed({ state: 'signed_out' })),
      status('opencode', true, true, { state: 'ready', install: 'terminal', signIn: 'none' }),
      status('other', true, true, { state: 'unknown', install: 'terminal', signIn: 'none' }),
    ]
    expect(signedOutTools(list).map((t) => t.name)).toEqual(['claude', 'antigravity'])
  })
  it('a sign-in that runs keeps its donut', () => {
    expect(signedOutTools([status('antigravity', true, false, managed({ state: 'signing_in' }))]).map((t) => t.name)).toEqual(['antigravity'])
  })
})

describe('setupStates: what a list of tools depends on', () => {
  it('an install progress does not change it; a new state does', () => {
    const a = { antigravity: managed({ state: 'installing', progress: { received: 1, total: 10 } }) }
    const b = { antigravity: managed({ state: 'installing', progress: { received: 2, total: 10 } }) }
    expect(setupStates(a)).toBe(setupStates(b))
    expect(setupStates(a)).not.toBe(setupStates({ antigravity: managed({ state: 'signed_out' }) }))
  })
})
