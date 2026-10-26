import { describe, expect, it } from 'vitest'
import { HOST_WATCH } from '../packages/agent-host/src/adapters/local-process.js'
// @ts-expect-error — plain .mjs beside the smokes, which run under plain node
import { agentProcesses, parseProcesses } from '../packages/agent-host/scripts/smoke-processes.mjs'

/**
 * `ps -A -o pid=,ppid=,args=` on macOS with one agent running under a host (#1565 Mac re-check, smoke O3): the host
 * watch's subshell is the agent's child, and its script, `HOST_WATCH`, carries the agent's command line after it
 */
const psOf = (agent: string) =>
  [
    '  100     1 node --import tsx packages/agent-host/src/main.ts --port 0',
    ` 4242   100 ${agent}`,
    ` 4243  4242 /bin/sh -c ${HOST_WATCH} sh ${agent}`,
    ' 4300   100 /bin/zsh -c echo hi',
  ].join('\n')

describe('the agent processes a smoke counts', () => {
  it('counts an agent once, not its host watch, whose command line names the agent too', () => {
    const opencode = agentProcesses(parseProcesses(psOf('/usr/local/bin/opencode acp')), (cmd: string) => /opencode/i.test(cmd) && /\bacp\b/.test(cmd))
    expect(opencode.map((p: { pid: string }) => p.pid)).toEqual(['4242'])
    const cursor = agentProcesses(parseProcesses(psOf('/Users/x/.local/share/cursor-agent/versions/1/node index.js acp')), (cmd: string) => /cursor-agent.* acp/.test(cmd))
    expect(cursor.map((p: { pid: string }) => p.pid)).toEqual(['4242'])
  })

  it('counts two agents of one host as two', () => {
    const two = `${psOf('/usr/local/bin/opencode acp')}\n 5000   100 /usr/local/bin/opencode acp`
    expect(agentProcesses(parseProcesses(two), (cmd: string) => /opencode.*\bacp\b/.test(cmd)).map((p: { pid: string }) => p.pid)).toEqual(['4242', '5000'])
  })
})
