import { pathsOf } from '../../os.js'
import { realOs } from '../../os/real.js'
import { isObj } from '../../json-value.js'
import { claudeConfigDir } from './lsp-plugins.js'

/** Reads a file's text; rejects when there is none */
export type ReadText = (path: string) => Promise<string>

const readText: ReadText = (path) => realOs().files.promises.readFile(path, 'utf8')

/**
 * The API host Claude Code's turns reach (`AgentAdapter.apiUrl`, #1415): `ANTHROPIC_BASE_URL` from the user settings' `env`
 * (`settings.json` in `CLAUDE_CONFIG_DIR` or `~/.claude`, which the CLI applies over the environment it inherits), else the
 * variable the host passes on, else Anthropic's own. A project's own settings can set it too; that one is not read, so such a
 * session's probe asks Anthropic's host, and the wait still ends at the probe cap (`turn-continue.ts`)
 */
export async function claudeApiUrl(
  env: Record<string, string | undefined> = process.env,
  configDir: string = claudeConfigDir(env),
  read: ReadText = readText,
): Promise<string> {
  const fromSettings = await read(pathsOf().join(configDir, 'settings.json'))
    .then((text) => {
      const j: unknown = JSON.parse(text)
      const vars = isObj(j) && isObj(j.env) ? j.env : {}
      return typeof vars.ANTHROPIC_BASE_URL === 'string' ? vars.ANTHROPIC_BASE_URL : ''
    })
    // No settings file, or one that is not JSON: the CLI reads nothing from it either
    .catch(() => '')
  return fromSettings || env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
}
