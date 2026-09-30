import { describe, expect, it, vi } from 'vitest'

/**
 * `claude --version` does not check authentication — it succeeds even with zero credentials
 * configured. So the old `detect()` reported "installed" as "logged in", and a Claude that was
 * not logged in always showed as "ready" in the UI (#11). Here the CLI is swapped for a fake so
 * that this checks only **whether `detect()` actually asks about authentication** — calling the
 * real CLI would make the result depend on the user's own login state, and the test would settle
 * nothing.
 */
const cli = vi.hoisted(() => ({
  /** Takes an argument array and either returns stdout or throws (a throw can still carry stdout). */
  run: (_args: string[]): { stdout: string } => ({ stdout: '' }),
}))

// The adapter calls promisify(execFile), so we attach promisify.custom to resolve to
// {stdout, stderr} the way the real execFile does. Without it, promisify would return only the
// first argument (a string).
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile = (_file: string, args: string[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      try {
        resolve({ ...cli.run(args), stderr: '' })
      } catch (e) {
        reject(e as Error)
      }
    })
  return { execFile: Object.assign(execFile, { [promisify.custom]: execFile }) }
})

vi.mock('../../env-path.js', () => ({ whichTool: () => '/usr/local/bin/claude' }))

const { ClaudeAdapter } = await import('./index.js')

/** Simulates a CLI that dies with exit code 1 but still left JSON on stdout. */
function failWithStdout(stdout: string): never {
  throw Object.assign(new Error('Command failed'), { stdout })
}

describe('login determination in claude detect()', () => {
  it('reports not logged in when auth status says loggedIn:false (the core of #11)', async () => {
    cli.run = (args) =>
      args[0] === '--version'
        ? { stdout: '2.1.223 (Claude Code)\n' }
        : { stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) }

    const d = await new ClaudeAdapter().detect()

    expect(d).toMatchObject({ tool: 'claude', installed: true, loggedIn: false })
    expect(d.detail).toContain('login required')
  })

  it('reads the JSON on stdout even though auth status dies with exit code 1 when not logged in', async () => {
    cli.run = (args) =>
      args[0] === '--version'
        ? { stdout: '2.1.223 (Claude Code)\n' }
        : failWithStdout(JSON.stringify({ loggedIn: false }))

    expect(await new ClaudeAdapter().detect()).toMatchObject({ installed: true, loggedIn: false })
  })

  it('passes through when logged in, without extra clutter attached to detail', async () => {
    cli.run = (args) =>
      args[0] === '--version'
        ? { stdout: '2.1.223 (Claude Code)\n' }
        : { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) }

    const d = await new ClaudeAdapter().detect()

    expect(d).toMatchObject({ installed: true, loggedIn: true })
    expect(d.detail).not.toContain('login required')
  })

  it('an old CLI that does not know the auth subcommand means "unknown", not "not logged in" — passes it through', async () => {
    // A wrong "not logged in" would push the person to fix something that is not broken, which is worse than the status quo.
    cli.run = (args) => {
      if (args[0] === '--version') return { stdout: '1.0.0 (Claude Code)\n' }
      failWithStdout("error: unknown command 'auth'")
    }

    expect(await new ClaudeAdapter().detect()).toMatchObject({ installed: true, loggedIn: true })
  })

  it('does not fire an inference call (-p) just to check authentication — the app should not be billed every time it starts', async () => {
    const calls: string[][] = []
    cli.run = (args) => {
      calls.push(args)
      return args[0] === '--version' ? { stdout: '2.1.223\n' } : { stdout: '{"loggedIn":true}' }
    }

    await new ClaudeAdapter().detect()

    expect(calls).toEqual([['--version'], ['auth', 'status', '--json']])
    expect(calls.flat()).not.toContain('-p')
  })

  it('reports not installed, as before, when the CLI is missing entirely', async () => {
    cli.run = () => {
      throw new Error('ENOENT')
    }

    expect(await new ClaudeAdapter().detect()).toMatchObject({ installed: false, loggedIn: false })
  })
})
