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
