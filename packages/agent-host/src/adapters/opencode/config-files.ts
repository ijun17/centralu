import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, relative } from 'node:path'
import { isObj, type Obj } from '../../json-value.js'
import type { OpenCodeConfigs } from './config.js'

/**
 * The person's OpenCode configuration a session in `cwd` would read (1.19.4, `Config.loadInstanceState` and
 * `ConfigPaths`, read in its binary): the global files, `OPENCODE_CONFIG`, the project's `opencode.json(c)` from the
 * folder up to its repository's root, the `.opencode` folders there and in the home folder, `OPENCODE_CONFIG_DIR`,
 * and the managed folder; in each config folder, the agents its markdown files define. A file that is not there or
 * does not parse adds nothing. Not read: an OpenCode account's organisation config, which comes from its server.
 */
export function readOpenCodeConfigs(cwd: string, env: Readonly<Record<string, string | undefined>>, home = homedir()): OpenCodeConfigs {
  const global = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
  const project = !env.OPENCODE_DISABLE_PROJECT_CONFIG
  const upward = project ? foldersUp(cwd) : []
  const dotFolders = [...upward.map((d) => join(d, '.opencode')), join(home, '.opencode'), ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : [])]
  const files = [
    ...['config.json', 'opencode.json', 'opencode.jsonc'].map((f) => join(global, f)),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ...upward.flatMap((d) => CONFIG_NAMES.map((f) => join(d, f))),
    ...dotFolders.flatMap((d) => CONFIG_NAMES.map((f) => join(d, f))),
    ...CONFIG_NAMES.map((f) => join(managedFolder(env), f)),
  ]
  return {
    layers: files.map(readConfig).filter((c): c is Obj => c !== null),
    agentFiles: [...new Set([global, ...dotFolders].flatMap(agentNames))],
  }
}

const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc']

/** The folder and each above it, up to the repository's root (the folder holding `.git`), else to the top */
function foldersUp(cwd: string): string[] {
  const out: string[] = []
  for (let d = cwd; ; d = dirname(d)) {
    out.push(d)
    if (existsSync(join(d, '.git')) || dirname(d) === d) return out
  }
}

function managedFolder(env: Readonly<Record<string, string | undefined>>): string {
  if (env.OPENCODE_TEST_MANAGED_CONFIG_DIR) return env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  if (process.platform === 'win32') return join(env.ProgramData || 'C:\\ProgramData', 'opencode')
  return process.platform === 'darwin' ? '/Library/Application Support/opencode' : '/etc/opencode'
}

function readConfig(path: string): Obj | null {
  try {
    const v: unknown = JSON.parse(withoutComments(readFileSync(path, 'utf8')))
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** JSON with comments and trailing commas, as OpenCode reads its config, made plain JSON */
function withoutComments(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      const end = stringEnd(text, i)
      out += text.slice(i, end)
      i = end - 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) break
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i + 1
  }
  return text.length
}

/** The agents a config folder's markdown files define: `{agent,agents}/**\/*.md` by their path, `{mode,modes}/*.md` */
function agentNames(folder: string): string[] {
  const named = (sub: string, deep: boolean) => markdown(join(folder, sub), deep).map((f) => relative(join(folder, sub), f).replaceAll('\\', '/').slice(0, -extname(f).length))
  return [...named('agent', true), ...named('agents', true), ...named('mode', false), ...named('modes', false)]
}

function markdown(folder: string, deep: boolean): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true }).flatMap((e) => {
      const path = join(folder, e.name)
      if (e.isDirectory()) return deep ? markdown(path, deep) : []
      return e.name.endsWith('.md') ? [path] : []
    })
  } catch {
    return []
  }
}
