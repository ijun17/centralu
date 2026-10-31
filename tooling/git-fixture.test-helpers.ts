import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** No background gc or maintenance in a fixture repository: it would race the test's own git calls. */
export const NO_GIT_MAINTENANCE = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' }
/** The environment of a fixture's git: no system or user config, no prompt, the C locale. */
export const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...NO_GIT_MAINTENANCE }

/** Runs `git` in `cwd` under {@link GIT_ENV}; its output without the trailing newline. */
export const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()

/** Runs `git` in `cwd` as an author `t` that signs nothing and leaves line ends alone (a checkout made of copied files). */
export const gitAsT = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * A bare repository `<root>/origin.git` standing for GitHub's and a checkout `<root>/work` with a committer, on `main`.
 * The checkout's remote is GitHub's address, which git rewrites to the bare one (`insteadOf`), so code that checks the
 * remote is the repository sees what it sees on a real checkout; `plain` makes the remote the bare repository's path.
 */
export function githubStandIn(root: string, { plain = false }: { plain?: boolean } = {}) {
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  g(root, 'init', '-q', '--bare', '-b', 'main', origin)
  g(root, 'init', '-q', '-b', 'main', work)
  g(work, 'config', 'user.name', 'Tester')
  g(work, 'config', 'user.email', 'tester@example.test')
  g(work, 'config', 'commit.gpgsign', 'false')
  g(work, 'remote', 'add', 'origin', plain ? origin : 'https://github.com/ijun17/centralu.git')
  if (!plain) g(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/ijun17/centralu.git')
  return { origin, work }
}
