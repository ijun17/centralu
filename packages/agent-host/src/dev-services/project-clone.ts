import { runGit } from './git-exec.js'

/**
 * Cloning a repository into a new project's folder (#515). The folder is already made (empty) by
 * `makeProjectFolder`, and the address already passed `gitSourceError`; this runs the clone and says, in one sentence,
 * why it failed.
 *
 * It runs on the machine the project lives on, with **that machine's git and its own saved sign-ins** (a credential
 * helper, an ssh key or agent), and never asks for one: there is nobody at a terminal to answer, and a dialog popping
 * up on a remote Windows desktop would hang the call. So:
 *
 *   GIT_TERMINAL_PROMPT=0         git does not ask for a user name or password on a terminal
 *   GIT_ASKPASS, SSH_ASKPASS ''   no helper program is asked either (git skips an empty one)
 *   SSH_ASKPASS_REQUIRE=never     nor does ssh
 *   GCM_INTERACTIVE=never         Git Credential Manager (Windows' default helper) uses what it has saved, no window
 *   GIT_SSH_COMMAND               `ssh -o BatchMode=yes`, unless the person set their own ssh command (`GIT_SSH_COMMAND`,
 *                                 `GIT_SSH` or `core.sshCommand`): then theirs, as they set it
 *
 * Submodules are not cloned (no `--recurse-submodules`): their addresses are the repository's to choose, past the one
 * the person approved. `ext::` and `file://` are refused for the same reason (by the address rule, and again here with
 * `protocol.<name>.allow=never`, which also covers a redirect).
 *
 * The repository's own programs cannot run during a clone: it has no configuration or hooks yet, so this runs git as
 * plain git does (`allowRepoPrograms`), with the person's own configuration (an LFS filter, for one).
 */

/** How long a clone may take before it is stopped and its folder removed */
export const CLONE_TIMEOUT_MS = 10 * 60_000

/** The settings that keep a clone from asking anyone anything — see above */
export function cloneEnv(env: NodeJS.ProcessEnv = process.env, ownSshCommand = false): Record<string, string> {
  const out: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
  }
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !ownSshCommand) out.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  return out
}

/** The arguments of one clone: into `into`, which exists and is empty */
export function cloneArgs(url: string, into: string, branch?: string): string[] {
  return [
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=never',
    'clone',
    ...(branch ? ['--branch', branch] : []),
    '--',
    url,
    into,
  ]
}

/** A failed clone, said for the person (and the model) in one sentence */
export function cloneFailure(e: unknown, url: string, branch?: string): string {
  const err = e as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown; message?: string }
  if (err.code === 'ENOENT') return 'git is not installed on this machine, so nothing can be cloned.'
  if (err.killed || err.signal === 'SIGTERM') return `The clone took longer than ${CLONE_TIMEOUT_MS / 60_000} minutes and was stopped; nothing was kept.`
  const stderr = typeof err.stderr === 'string' ? err.stderr : String(err.message ?? '')
  if (/terminal prompts disabled|could not read (Username|Password)|Authentication failed|Permission denied \(|Host key verification failed|HTTP Basic: Access denied|returned error: 40[13]/i.test(stderr)) {
    return `${url} needs a sign-in this machine does not have saved — sign in to it on that machine (or use an address it can reach), then try again.`
  }
  if (branch && /Remote branch .* not found|couldn't find remote ref/i.test(stderr)) return `The repository has no branch "${branch}".`
  if (/Could not resolve host|Could not resolve hostname|Name or service not known|Connection refused|timed out/i.test(stderr)) {
    return `This machine could not reach the host of ${url}.`
  }
  if (/not found|does not appear to be a git repository|returned error: 404/i.test(stderr)) {
    return `There is no repository at ${url} (or it is private and needs a sign-in).`
  }
  const last = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
  return `git clone failed${last ? `: ${last.replace(/^fatal:\s*/, '')}` : '.'}`
}

/** Clones `url` into the empty folder `into`; rejects with `cloneFailure`'s sentence */
export async function cloneInto(url: string, into: string, cwd: string, branch?: string): Promise<void> {
  // The person's own `core.sshCommand` wins over our BatchMode one (GIT_SSH_COMMAND would outrank it)
  const own = (await runGit(cwd, ['config', '--get', 'core.sshCommand'], { allowRepoPrograms: true }).catch(() => '')).trim() !== ''
  try {
    await runGit(cwd, cloneArgs(url, into, branch), { allowRepoPrograms: true, timeout: CLONE_TIMEOUT_MS, env: cloneEnv(process.env, own) })
  } catch (e) {
    throw Object.assign(new Error(cloneFailure(e, url, branch)), { code: 'internal' })
  }
}
