import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * dev 전용 git 조회 (docs/agent-host.md §5).
 * Tauri 전환 4단계에서 Rust git2로 교체되므로 의도적으로 얇게 유지한다 — 버릴 코드다.
 */
export type GitSummary = { isRepo: boolean; branch: string; changedFiles: number }

export async function gitSummary(cwd: string): Promise<GitSummary> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain=v2', '--branch'], { cwd, timeout: 5000 })
    let branch = '(detached)'
    let changed = 0
    for (const line of stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim()
      else if (line && !line.startsWith('#')) changed++
    }
    return { isRepo: true, branch, changedFiles: changed }
  } catch {
    return { isRepo: false, branch: '', changedFiles: 0 }
  }
}
