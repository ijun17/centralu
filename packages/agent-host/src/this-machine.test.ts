import { describe, expect, it } from 'vitest'
import { isThisMachineHost } from './this-machine.js'

describe('isThisMachineHost', () => {
  it.each([
    ['localhost'],
    ['LocalHost'],
    ['app.localhost'],
    ['127.0.0.1'],
    ['127.255.255.254'],
    ['0.0.0.0'],
    ['0.1.2.3'],
    ['169.254.169.254'],
    ['169.254.0.1'],
    ['::1'],
    ['[::1]'],
    ['::'],
    ['fe80::1'],
    ['[fe80::1]'],
    ['febf::1'],
    ['::ffff:127.0.0.1'],
    ['[::ffff:7f00:1]'],
    ['localhost.'],
    ['app.localhost.'],
    ['127.0.0.1.'],
    ['[::7f00:1]'],
    ['::127.0.0.1'],
    ['::a9fe:a9fe'],
    ['[64:ff9b::7f00:1]'],
    ['64:ff9b::127.0.0.1'],
    ['[64:ff9b::a9fe:a9fe]'],
    ['64:ff9b:0:0:0:0:0:1'],
  ])('%s is this machine', (host) => {
    expect(isThisMachineHost(host)).toBe(true)
  })

  it.each([
    ['example.com'],
    ['localhost.example.com'],
    ['notlocalhost'],
    ['128.0.0.1'],
    ['126.255.255.255'],
    ['169.253.0.1'],
    ['169.255.0.1'],
    ['10.0.0.1'],
    ['192.168.1.1'],
    ['2001:db8::1'],
    ['[2606:4700::1111]'],
    ['fec0::1'],
    ['localhost.example.com.'],
    ['[::808:808]'],
    ['[64:ff9b::808:808]'],
    ['[64:ff9b::1:7f00:1]'],
    ['[2001::7f00:1]'],
  ])('%s is not', (host) => {
    expect(isThisMachineHost(host)).toBe(false)
  })
})
