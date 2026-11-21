import { execText, type ProbeOptions } from './os/exec.js'
import { toolLaunch } from './tool-launch.js'

/**
 * A tool's CLI asked one short question by name (`--version`, `auth status`), found and started as the host does (`toolLaunch`)
 * and run with `execText` so a limit ends it with all it started; a failure names the tool
 */
export function execTool(name: string, args: readonly string[], options: Pick<ProbeOptions, 'timeoutMs' | 'maxBuffer' | 'input'>): Promise<{ stdout: string; stderr: string }> {
  const launch = toolLaunch(name)
  return execText(launch.command, [...launch.args, ...args], { ...options, name })
}
