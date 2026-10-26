import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { frameRecorder } from './recorder.js'

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the frame recorder', () => {
  it('writes a later host’s process to a file of its own, not after an earlier host’s (#1562 review)', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-frames-'))
    // What the host before this one wrote for the same session: its count started at 1 too
    writeFileSync(join(dir, 's-restarted.1.jsonl'), '{"t":0,"dir":"out","line":"earlier"}\n')
    frameRecorder('s-restarted', { CC_RECORD_FRAMES: dir })!.frame('out', 'later')
    expect(readdirSync(dir).sort()).toEqual(['s-restarted.1.jsonl', 's-restarted.2.jsonl'])
    expect(readFileSync(join(dir, 's-restarted.1.jsonl'), 'utf8')).not.toContain('later')
  })
})
