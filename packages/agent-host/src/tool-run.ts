import { execText } from './os/exec.js'
import { toolLaunch } from './tool-launch.js'

/**
 * A tool's CLI asked one short question by its name (`--version`, `--help`, `auth status`): found and started as the host
 * starts it (`toolLaunch`), and asked with `execText`, so a limit ends it with everything it started. A failure names the
 * tool. For the scripts and checks that probe a tool on PATH; an adapter that finds its tool its own way calls `execText`.
 */
export function execTool(name: string, args: readonly string[], options: { timeoutMs: number; maxBuffer?: number; input?: string }): Promise<{ stdout: string; stderr: string }> {
  const launch = toolLaunch(name)
  return execText(launch.command, [...launch.args, ...args], { ...options, name })
}
