import { whichTool } from '../../env-path.js'
import { launchFor, type ToolLaunch } from '../../tool-launch.js'

/** The installed CLI, as `launchFor` starts it (Windows: the npm shim's `opencode.exe`, not the `.cmd` through a shell) */
export function findOpenCode(env: NodeJS.ProcessEnv = process.env): ToolLaunch | null {
  const path = whichTool('opencode', env)
  return path ? launchFor(path) : null
}
