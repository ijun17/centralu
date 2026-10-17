import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { MockPlatform } from './index.js'

/**
 * The mock fans out the way the web client does (#972 item 4): a subscriber that throws is reported, and every
 * other subscriber still gets the value. Before, one throwing subscriber kept an event from the rest in the mock only,
 * so a test could see a screen break that the app would not.
 */
describe('the mock fan-out', () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  afterEach(() => quiet.mockClear())
  const boom = () => {
    throw new Error('subscriber broke')
  }

  it('an event and a connection change still reach the subscriber after one that throws', () => {
    const m = new MockPlatform()
    const events: NormalizedEvent[] = []
    const states: string[] = []
    m.agents.subscribe(boom)
    m.agents.subscribe((e) => events.push(e))
    m.agents.onConnectionChange(boom)
    m.agents.onConnectionChange((s) => states.push(s))
    m.emit({ type: 'projects_changed' } as NormalizedEvent)
    m.setConnectionState('disconnected')
    expect(events).toHaveLength(1)
    expect(states).toEqual(['disconnected'])
    expect(quiet).toHaveBeenCalledTimes(2)
  })

  it('the keeper’s activity report, an app link and terminal output do too', () => {
    const m = new MockPlatform()
    const busy: (boolean | null)[] = []
    const links: string[] = []
    const out: string[] = []
    m.relaunch.watchBusy((b) => {
      if (b) boom()
    })
    m.relaunch.watchBusy((b) => busy.push(b))
    m.system.onAppLink(boom)
    m.system.onAppLink((l) => links.push(l))
    m.terminal.onOutput(boom)
    m.terminal.onOutput((e) => out.push(e.data))
    m.setHostBusy(true)
    m.openAppLink('centralu://app/x')
    m.emitTerminal('t1', 'hi')
    expect(busy).toEqual([false, true])
    expect(links).toEqual(['centralu://app/x'])
    expect(out).toEqual(['hi'])
  })
})
