import { describe, expect, it } from 'vitest'
import { jsonLines } from '../json-value.js'
import { parseAutostartLine } from './autostart.js'
import { parseConnectionLine, parseDetachLine, parseRevoke, unreachable, whyOrExit } from './tunnel.js'
import { parseStopLine } from './update.js'

const CONNECTION = {
  v: 1,
  port: 4100,
  token: 'tok',
  version: '1.2.3',
  protocolVersion: 7,
  dataDir: '/d',
  hostRunning: true,
}
const BANNER =
  '** WARNING: connection is not using a post-quantum key exchange algorithm.\r\nWelcome to the machine\r\n'

/** What each remote command prints among ssh's noise: a banner first, CRLF line ends, and a partial line cut off at the end */
const noisy = (line: unknown, others: string[] = []) =>
  `${BANNER}${[...others, JSON.stringify(line)].join('\r\n')}\r\n{"v":1,"detach":{"ok":tr`

describe('the last JSON line a remote printed (parsers)', () => {
  it('reads the connection line past a banner, CRLF and a partial last line', () => {
    expect(parseConnectionLine(noisy(CONNECTION)).port).toBe(4100)
    expect(parseConnectionLine(`${JSON.stringify(CONNECTION)}\n`).token).toBe('tok')
  })

  it('takes the last connection line when several parse, and skips lines that are not one', () => {
    const first = JSON.stringify({ ...CONNECTION, port: 1 })
    const last = JSON.stringify({ ...CONNECTION, port: 2 })
    expect(parseConnectionLine(`${first}\n{"other":1}\n${last}\n[1]\n7\nnull\n`).port).toBe(2)
    expect(() => parseConnectionLine(`${BANNER}[1]\n7\n`)).toThrow('did not print a connection line')
  })

  it('refuses a connection line of another version', () => {
    expect(() => parseConnectionLine(JSON.stringify({ ...CONNECTION, v: 2 }))).toThrow('connection format 2')
  })

  it('reads the detach answer past noise and gives the connection line inside it', () => {
    const ok = { ...CONNECTION, detach: { ok: true, how: 'spawn' } }
    expect(parseDetachLine(`${BANNER}${JSON.stringify(ok)}\r\n{"v":1,"det`)).toMatchObject({
      ok: true,
      how: 'spawn',
      line: { port: 4100, token: 'tok' },
    })
    const refused = { v: 1, detach: { ok: false, reason: 'busy', message: 'busy there', node: '20' } }
    expect(parseDetachLine(`${JSON.stringify(ok)}\n${JSON.stringify(refused)}\r\n`)).toEqual({
      ok: false,
      reason: 'busy',
      message: 'busy there',
      node: '20',
    })
    expect(() => parseDetachLine(`${BANNER}{"v":1}\n`)).toThrow('did not say whether it started')
  })

  it('reads --revoke past noise, last line first, null when it printed none', () => {
    expect(parseRevoke(noisy({ v: 1, revoked: true }))).toBe(true)
    expect(parseRevoke(`{"revoked":true}\n{"revoked":false}\n\n`)).toBe(false)
    expect(parseRevoke(`${BANNER}{"revoked":"yes"}\n5\n`)).toBeNull()
    expect(parseRevoke('')).toBeNull()
  })

  it('reads --autostart past noise and ignores a line of another version', () => {
    const line = { v: 1, autostart: { ok: true, on: true, how: 'systemd', linger: true, message: 'fine' } }
    expect(parseAutostartLine(noisy(line))).toMatchObject({ ok: true, state: { on: true }, message: 'fine' })
    expect(
      parseAutostartLine(`${JSON.stringify(line)}\n${JSON.stringify({ ...line, v: 2 })}\n`),
    ).toMatchObject({ ok: true })
    expect(parseAutostartLine(`${BANNER}[1]\n`)).toBeNull()
  })

  it('reads --stop past noise, the last answer winning', () => {
    const stop = (o: object) => JSON.stringify({ v: 1, stop: o })
    expect(parseStopLine(noisy({ v: 1, stop: { ok: true, wasRunning: true } }))).toEqual({
      ok: true,
      wasRunning: true,
      message: null,
    })
    expect(
      parseStopLine(`${stop({ ok: true, wasRunning: true })}\r\n${stop({ ok: false, message: 'busy' })}\r\n`),
    ).toEqual({ ok: false, wasRunning: false, message: 'busy' })
    expect(parseStopLine(`${BANNER}`)).toBeNull()
  })
})

describe('jsonLines', () => {
  it('lists the objects last line first and skips everything else', () => {
    expect(jsonLines(`x\r\n {"a":1} \r\n[2]\n3\n"s"\nnull\n{bad}\n{"b":2}\n{"c":`)).toEqual([
      { b: 2 },
      { a: 1 },
    ])
  })
})

describe('what the person is told when a command did not answer', () => {
  it('names the target, and the last line that says why (or that there was none)', () => {
    expect(unreachable('box', 'ssh: connect to host box port 22: Connection refused\n')).toBe(
      'ssh could not reach box: ssh: connect to host box port 22: Connection refused',
    )
    expect(unreachable('box', '')).toBe('ssh could not reach box: no answer')
  })

  it('ends with the stderr line, else the exit code, else nothing', () => {
    expect(whyOrExit({ code: 1, stdout: '', stderr: 'boom: not found\r\n' })).toBe(': boom: not found')
    expect(whyOrExit({ code: 3, stdout: '', stderr: '' })).toBe(' (exit 3)')
    expect(whyOrExit({ code: 0, stdout: '', stderr: '' })).toBe('')
    expect(whyOrExit({ code: null, stdout: '', stderr: '' })).toBe('')
  })
})
