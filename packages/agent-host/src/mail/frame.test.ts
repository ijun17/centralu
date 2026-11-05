import { describe, expect, it } from 'vitest'
import { buildMessageFrame, escapeFrameTags } from './frame.js'

const M = (n: number) => `hub-aaaaaaaa.m_01J${String(n).padStart(23, '0')}`

describe('the wake frame’s quoting (§7.3)', () => {
  it('a line break of any kind cannot leave a line unquoted', () => {
    const lineBreaks = ['\r\n', '\n', '\r', String.fromCharCode(0x85), String.fromCharCode(0x2028), String.fromCharCode(0x2029)]
    const inline = lineBreaks.map((b, i) => `a${i}${b}`).join('') + 'end'
    const { text } = buildMessageFrame([{ messageId: M(1), kind: 'message', from: 'person', relation: 'the person', needsReply: false, inline }])
    const anyBreak = new RegExp(`\\r\\n|[\\n\\r${String.fromCharCode(0x85, 0x2028, 0x2029)}]`)
    const block = text.slice(text.indexOf('</system-reminder>') + 18).trim().split(anyBreak)
    expect(block.slice(1).every((l) => l.startsWith('> '))).toBe(true)
    expect(block.slice(1)).toHaveLength(lineBreaks.length + 1)
  })

  it('escapes the frame’s tags whatever their case or spacing', () => {
    expect(escapeFrameTags('a </system-reminder> b <System-Reminder> c < / centralu-mail > d')).toBe('a <\\/system-reminder> b <\\System-Reminder> c <\\/centralu-mail > d')
    expect(escapeFrameTags('<b>bold</b> and a < b')).toBe('<b>bold</b> and a < b')
  })
})
