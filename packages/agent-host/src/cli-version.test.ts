import { describe, expect, it } from 'vitest'
import { installedCliVersion, npmPackageVersion, type CliVersionDeps } from './cli-version.js'

/**
 * Reading the installed agent CLI's version (#297) against the install layouts measured on 2026-10-05, with the file
 * system and process runs faked: a test must never run the person's real `claude`.
 */
function deps(files: Record<string, string>, over: Partial<CliVersionDeps> = {}): CliVersionDeps & { runs: string[][] } {
  const runs: string[][] = []
  return {
    runs,
    platform: 'darwin',
    which: () => null,
    launch: (path) => ({ command: path, args: [] }),
    realpath: (p) => p,
    read: (p) => {
      if (p in files) return files[p]!
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    run: async (command, args) => {
      runs.push([command, ...args])
      throw new Error('not expected to run')
    },
    ...over,
  }
}

const CLAUDE_PKG = JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.289' })
const CODEX_PKG = JSON.stringify({ name: '@openai/codex', version: '0.160.0' })

describe('the installed agent CLI version (#297)', () => {
  it('reads npm’s package.json where the symlink on PATH points, and starts no process', async () => {
    // /opt/homebrew/bin/claude -> ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe (measured)
    const d = deps(
      { '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/package.json': CLAUDE_PKG },
      {
        which: () => '/opt/homebrew/bin/claude',
        realpath: (p) => (p === '/opt/homebrew/bin/claude' ? '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe' : p),
      },
    )
    expect(await installedCliVersion('claude', '@anthropic-ai/claude-code', d)).toBe('2.1.289')
    expect(d.runs).toEqual([])
  })

  it('ignores a package.json above the binary that belongs to another package', () => {
    const d = deps({ '/usr/local/package.json': JSON.stringify({ name: 'something-else', version: '9.9.9' }) })
    expect(npmPackageVersion('/usr/local/bin/codex', '@openai/codex', d)).toBeNull()
  })

  it('on Windows reads the package of the script npm’s shim starts, never running npm’s claude.exe (#353)', async () => {
    const root = 'C:\\Users\\me\\AppData\\Roaming\\npm'
    const exe = `${root}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`
    const d = deps(
      { [`${root}\\node_modules\\@anthropic-ai\\claude-code\\package.json`]: CLAUDE_PKG },
      { platform: 'win32', which: () => `${root}\\claude.cmd`, launch: () => ({ command: exe, args: [] }) },
    )
    expect(await installedCliVersion('claude', '@anthropic-ai/claude-code', d)).toBe('2.1.289')
    expect(d.runs).toEqual([])
  })

  it('on Windows answers unknown rather than run a CLI inside node_modules whose package.json it cannot read', async () => {
    const exe = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
    const d = deps({}, { platform: 'win32', which: () => 'C:\\npm\\codex.cmd', launch: () => ({ command: 'C:\\node.exe', args: [exe] }) })
    expect(await installedCliVersion('codex', '@openai/codex', d)).toBeNull()
    expect(d.runs).toEqual([])
  })

  it('reads a Windows shim’s script entry (codex.js) for its package', async () => {
    const exe = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
    const d = deps(
      { 'C:\\npm\\node_modules\\@openai\\codex\\package.json': CODEX_PKG },
      { platform: 'win32', which: () => 'C:\\npm\\codex.cmd', launch: () => ({ command: 'C:\\node.exe', args: [exe] }) },
    )
    expect(await installedCliVersion('codex', '@openai/codex', d)).toBe('0.160.0')
  })

  it('takes the version from the file name of Claude Code’s native install', async () => {
    const d = deps(
      {},
      { which: () => '/Users/me/.local/bin/claude', realpath: () => '/Users/me/.local/share/claude/versions/2.1.290' },
    )
    expect(await installedCliVersion('claude', '@anthropic-ai/claude-code', d)).toBe('2.1.290')
    expect(d.runs).toEqual([])
  })

  it('off Windows falls back to `--version` for an install outside npm (a Homebrew cask)', async () => {
    const d = deps({}, { which: () => '/opt/homebrew/bin/codex', run: async () => 'codex-cli 0.161.0\n' })
    expect(await installedCliVersion('codex', '@openai/codex', d)).toBe('0.161.0')
  })

  it('answers null for a CLI that is not installed or will not say', async () => {
    expect(await installedCliVersion('codex', '@openai/codex', deps({}))).toBeNull()
    expect(await installedCliVersion('codex', '@openai/codex', deps({}, { which: () => '/bin/codex' }))).toBeNull()
  })
})
