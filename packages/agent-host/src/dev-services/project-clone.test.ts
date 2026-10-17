import { describe, expect, it } from 'vitest'
import { cloneArgs, cloneEnv, cloneFailure } from './project-clone.js'

/**
 * The parts of a clone (#515) that a local test server cannot show: a clone run with no terminal fails the same with or
 * without the prompt settings, so what keeps it from asking, on a machine where something could answer, is pinned
 * here. The end-to-end clone is `sessions/clone-project.test.ts`.
 */
describe('a clone asks nobody', () => {
  it('turns off git\'s prompt, every askpass helper and Git Credential Manager\'s window, and ssh\'s questions', () => {
    expect(cloneEnv({})).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    })
  })

  it("leaves the person's own ssh command alone", () => {
    expect(cloneEnv({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work' })).not.toHaveProperty('GIT_SSH_COMMAND')
    expect(cloneEnv({ GIT_SSH: 'plink' })).not.toHaveProperty('GIT_SSH_COMMAND')
    expect(cloneEnv({}, true)).not.toHaveProperty('GIT_SSH_COMMAND')
  })
})

describe('the clone command', () => {
  it('ends options before the address, clones no submodules, and allows neither ext:: nor file://', () => {
    const args = cloneArgs('https://host/a.git', '/d/a', 'dev')
    expect(args).toEqual(['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'clone', '--branch', 'dev', '--', 'https://host/a.git', '/d/a'])
    expect(args.join(' ')).not.toMatch(/recurse|submodule/)
    expect(cloneArgs('https://host/a.git', '/d/a')).not.toContain('--branch')
  })
})

describe('why a clone failed, in one sentence', () => {
  const url = 'https://host/a.git'
  it('says a sign-in is missing, for https and for ssh', () => {
    for (const stderr of [
      "fatal: could not read Username for 'https://host': terminal prompts disabled",
      'git@host: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      'Host key verification failed.',
      'remote: HTTP Basic: Access denied\nfatal: Authentication failed',
    ]) {
      expect(cloneFailure({ stderr }, url), stderr).toMatch(/needs a sign-in/)
    }
  })

  it('names a missing branch, an unreachable host, a missing repository, a missing git and a clone that took too long', () => {
    expect(cloneFailure({ stderr: 'warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin' }, url, 'nope')).toBe('The repository has no branch "nope".')
    expect(cloneFailure({ stderr: 'fatal: unable to access: Could not resolve host: host' }, url)).toMatch(/could not reach/)
    expect(cloneFailure({ stderr: 'remote: Repository not found.\nfatal: repository not found' }, url)).toMatch(/no repository at/)
    expect(cloneFailure({ code: 'ENOENT' }, url)).toMatch(/git is not installed/)
    expect(cloneFailure({ timedOut: true, killed: true, signal: 'SIGKILL' }, url)).toMatch(/longer than 10 minutes/)
    expect(cloneFailure({ stderr: 'fatal: something else\n' }, url)).toBe('git clone failed: something else')
  })
})
