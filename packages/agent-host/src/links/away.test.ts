import { describe, expect, it } from 'vitest'
import { isNoAnswer } from './away.js'

/**
 * What ssh says when the machine gave no answer at all (#1398). The lines are ssh's own, as OpenSSH prints them on macOS, Linux
 * and Windows, with the `ssh could not reach <target>:` the tunnel puts in front.
 */
describe('a machine that does not answer', () => {
  it.each([
    'ssh could not reach jungi: ssh: connect to host jungi.tail3d9122.ts.net port 22: Operation timed out',
    'ssh could not reach box: ssh: connect to host box port 22: Connection timed out',
    'ssh could not reach box: ssh: connect to host 10.0.0.7 port 22: No route to host',
    'ssh could not reach box: ssh: connect to host 10.0.0.7 port 22: Network is unreachable',
    'ssh could not reach box: ssh: connect to host box port 22: Host is down',
    'ssh could not reach box: ssh: Could not resolve hostname box: Name or service not known',
    'ssh could not reach box: ssh: Could not resolve hostname box: nodename nor servname provided, or not known',
    'ssh could not reach box: ssh: Could not resolve hostname box: Temporary failure in name resolution',
    'ssh could not reach box: ssh: Could not resolve hostname box: No such host is known.',
  ])('is away: %s', (line) => {
    expect(isNoAnswer(line)).toBe(true)
  })

  it.each([
    'ssh could not reach box: me@box: Permission denied (publickey).',
    'ssh could not reach box: Host key verification failed.',
    'ssh could not reach box: @@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@',
    'ssh could not reach box: ssh: connect to host box port 22: Connection refused',
    'ssh could not reach box: kex_exchange_identification: Connection closed by remote host',
    'ssh could not reach box: Connection reset by 10.0.0.7 port 22',
    'Centralu could not be started on Box: the launcher refused a Node below the floor',
    'Centralu is not installed on Box (run `npm i -g centralu` there, then `centralu serve` once)',
    'ssh to box did not finish within 30 seconds',
    '',
  ])('stays an error: %s', (line) => {
    expect(isNoAnswer(line)).toBe(false)
  })
})
