import { describe, expect, it } from 'vitest'
import { exitLine, logReplay, UNREAD_LOG_LINE } from './logReplay.js'

function view() {
  const written: string[] = []
  return { written, log: logReplay((d) => written.push(d)) }
}

describe('a command log view joining the stored log and live output', () => {
  it('draws the stored log first, then what arrived while it was being read, then live output', () => {
    const { written, log } = view()
    log.chunk('b')
    log.replay('a')
    log.chunk('c')
    expect(written).toEqual(['a', 'b', 'c'])
  })

  it('stops holding output when the stored log cannot be read, and says the earlier output is missing', () => {
    const { written, log } = view()
    log.chunk('early')
    log.fail()
    log.chunk('later')
    expect(written).toEqual([UNREAD_LOG_LINE, 'early', 'later'])
    expect(UNREAD_LOG_LINE).toContain('earlier output could not be read')
  })

  it('stops holding output when the log belongs to another run, and draws none of it', () => {
    const { written, log } = view()
    log.chunk('stale')
    log.drop()
    log.replay('ignored')
    expect(written).toEqual([])
    log.chunk('live')
    expect(written).toEqual(['live'])
  })
})

// #1143 U18: the exit line was drawn by the live event past the hold, and again after the replay
describe('the exit line of a command log', () => {
  it('is drawn once, after the stored log, when the run ended before the log answered', () => {
    const { written, log } = view()
    log.chunk('out')
    log.exit(1)
    log.replay('history', 1)
    expect(written).toEqual(['history', 'out', exitLine(1)])
  })

  it('is drawn once, below the output, when only the stored log says the run ended', () => {
    const { written, log } = view()
    log.replay('history', 2)
    expect(written).toEqual(['history', exitLine(2)])
  })

  it('is drawn at once by a live exit after the stored log was drawn', () => {
    const { written, log } = view()
    log.replay('history', null)
    log.chunk('out')
    log.exit(0)
    expect(written).toEqual(['history', 'out', exitLine(0)])
  })

  it('is not drawn for a run the stored log says is still running', () => {
    const { written, log } = view()
    log.replay('history', null)
    expect(written).toEqual(['history'])
  })

  it('follows the unread line when the stored log could not be read', () => {
    const { written, log } = view()
    log.exit(127)
    log.fail()
    expect(written).toEqual([UNREAD_LOG_LINE, exitLine(127)])
  })

  it('is not drawn for a log that belongs to another run', () => {
    const { written, log } = view()
    log.exit(1)
    log.drop()
    expect(written).toEqual([])
  })

  it('names the code when there is one', () => {
    expect(exitLine(3)).toContain('exited (3)')
    expect(exitLine(null)).toContain('exited')
    expect(exitLine(null)).not.toContain('(')
  })
})
