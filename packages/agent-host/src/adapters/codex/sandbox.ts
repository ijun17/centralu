import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PermissionPreset } from '@cc/protocol'
import { runGit } from '../../dev-services/git-exec.js'

/** ThreadStart/ResumeParams in 0.160 take a sandbox mode, with its details in config (#582). */
export async function sandboxConfig(
  cwd: string,
  preset: PermissionPreset,
  readConfig: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const roots: string[] = []
  try {
    const stdout = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { timeout: 5000 })
    const [gitDir, commonDir] = stdout.trim().split(/\r?\n/)
    if (gitDir && commonDir) {
      const gitPath = await realpath(resolve(cwd, gitDir))
      const commonPath = await realpath(resolve(cwd, commonDir))
      if (gitPath !== commonPath) roots.push(commonPath)
    }
  } catch {
    // Non-git folders are valid sessions too. No guessed path becomes writable.
  }
  if (roots.length) {
    const config = await readConfig()
    const workspace = config.sandbox_workspace_write as { writable_roots?: unknown } | undefined
    if (Array.isArray(workspace?.writable_roots)) {
      roots.push(...workspace.writable_roots.filter((p): p is string => typeof p === 'string'))
    }
  }
  return {
    'sandbox_workspace_write.network_access': preset === 'auto',
    ...(roots.length ? { 'sandbox_workspace_write.writable_roots': [...new Set(roots)] } : {}),
  }
}
