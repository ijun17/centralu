/**
 * How the ACP smokes (`smoke-cursor.mjs`, `smoke-opencode.mjs`) find the agent processes they count, without a name
 * match that also counts what is not an agent.
 */
import { execFileSync } from 'node:child_process'

/** Every process running now: pid, parent pid, and its command line */
export function processes() {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }'], { encoding: 'utf8', maxBuffer: 64 << 20 })
        : execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 << 20 })
    return parseProcesses(out)
  } catch {
    return []
  }
}

/** `processes()`'s reading of one `pid ppid command line` row per line */
export function parseProcesses(out) {
  return out.split('\n').flatMap((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/)
    return m ? [{ pid: m[1], ppid: m[2], cmd: m[3] }] : []
  })
}

/**
 * The agents among `all`: the processes whose command line `isAgent` matches, but for one whose parent matches too. On
 * macOS and Linux the host watch is a subshell of the agent's whose script carries the agent's command line (#1562 Mac
 * re-check), so a name match alone counts each agent twice; one per agent, by parent, not by name.
 */
export function agentProcesses(all, isAgent) {
  const matched = all.filter((p) => isAgent(p.cmd) && !/^(pgrep|ps)\b/.test(p.cmd))
  const pids = new Set(matched.map((p) => p.pid))
  return matched.filter((p) => !pids.has(p.ppid))
}

/**
 * The agents of the hosts a smoke started, and never another on the machine (another Centralu install's agent, hours old,
 * is not a leftover of this run). Returns `pidsOf(hostPid)`: the agents among that host's descendants, read while it runs
 * (a killed host's children keep its pid as their parent's, so they stay in its tree), plus the ones seen before that
 * still run. `list` is `processes` unless a test gives rows.
 */
export function ownAgents(isAgent, list = processes) {
  const seen = new Set()
  return (hostPid) => {
    const all = list()
    const tree = new Set([String(hostPid)])
    for (let grew = true; grew; ) {
      grew = false
      for (const p of all) if (tree.has(p.ppid) && !tree.has(p.pid)) (tree.add(p.pid), (grew = true))
    }
    for (const p of agentProcesses(all, isAgent)) if (tree.has(p.pid)) seen.add(p.pid)
    const alive = new Set(all.map((p) => p.pid))
    return [...seen].filter((pid) => alive.has(pid))
  }
}
