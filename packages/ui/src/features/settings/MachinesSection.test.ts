import { describe, expect, it } from 'vitest'
import { connectAction } from './MachinesSection.jsx'

// #1143: where Centralu is stopped this computer starts none by itself, so the row's button says what it does there
describe('the button that opens a machine’s link', () => {
  it('is Start where Centralu is stopped, Connect where the link is down on purpose, Reconnect otherwise', () => {
    expect(connectAction('stopped')).toEqual({ label: 'Start', title: 'Starts Centralu there, which this computer does not do by itself' })
    expect(connectAction('disconnected')).toEqual({ label: 'Connect', title: 'Stays connected until you disconnect it' })
    expect(connectAction('unreachable')).toEqual({ label: 'Reconnect' })
  })
})
