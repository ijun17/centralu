import { whichTool } from '../../env-path.js'
import { runsAntigravity, type Platform } from '../../os.js'
import { launchFor, type ToolLaunch } from '../../tool-launch.js'

/** The installed `agy`, as `launchFor` starts it; null where this version does not run it (Windows) or it is not on PATH */
export function findAgy(env: NodeJS.ProcessEnv = process.env, platform?: Platform): ToolLaunch | null {
  if (!runsAntigravity(platform)) return null
  const path = whichTool('agy', env, platform)
  return path ? launchFor(path) : null
}
