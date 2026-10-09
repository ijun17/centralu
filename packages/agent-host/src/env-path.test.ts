import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { __resetToolPathCache, ensureToolPath, fallbackDirs, probeLoginShell, whichTool } from './env-path.js'

/**
 * Regression test for the packaged app not being able to find the CLI.
 *
 * The core point is not "it only finds things installed via Homebrew" but that **it uses the
 * user's login shell PATH as is**. Wherever the tool is installed — nvm, mise, a manual install —
 * it is found as long as the shell knows about it.
 */
describe('CLI search path augmentation', () => {
  it("finds a tool the shell knows even from the GUI app's meager PATH", () => {
    const original = process.env.PATH
    try {
      /*
       * Pick a tool the login shell knows — but ask with the same crippled PATH
       * the assertions below will use. An inherited-PATH probe passes for the
       * wrong reason: on CI the runner injects pnpm via the workflow (invisible
       * to shell rc files), so a fresh login shell "knows" the tool only while
       * it inherits today's PATH, and the post-cripple assertion then fails.
       * First seen on the first Linux run of this suite. If the shell's own
       * config can't find a tool from a bare PATH, there is nothing to verify
       * on this machine — that is what the early return below is for.
       */
      let probe: string
      try {
        probe = execFileSync(process.env.SHELL ?? '/bin/zsh', ['-ilc', 'command -v claude || command -v pnpm'], {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        }).trim()
      } catch {
        // `command -v` finding nothing exits 1, and execFileSync reports a
        // nonzero exit as a throw, not an empty string. That answer — "the
        // shell's own config knows no tool from a bare PATH" — is the same
        // "nothing to verify here" the early return below handles. CI runners
        // land here; dev machines with shell config don't.
        return
      }
      const toolPath = probe.split('\n').find((l) => l.startsWith('/'))
      if (!toolPath) return // If even the shell cannot find it, there is nothing to verify
      const toolName = toolPath.split('/').pop()!

      // The meager PATH the .app receives — the tool cannot be found in this state
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
      expect(whichTool(toolName)).toBeNull()

      // After augmentation it is found (wherever it is installed — Homebrew, nvm, or elsewhere)
      ensureToolPath()
      expect(whichTool(toolName)).toBeTruthy()
    } finally {
      process.env.PATH = original
    }
  })

  it('does not add a path that is already present a second time', () => {
    const original = process.env.PATH
    try {
      const { path } = ensureToolPath()
      const dirs = path.split(delimiter)
      expect(new Set(dirs).size).toBe(dirs.length)
    } finally {
      process.env.PATH = original
    }
  })

  it('a PATH with as many duplicates as new folders still gets the new folders, once each', () => {
    const original = process.env.PATH
    try {
      // What this machine adds to an empty PATH (from the login shell, or the fallback folders)
      process.env.PATH = ''
      const added = ensureToolPath().path.split(delimiter).filter(Boolean)
      if (added.length < 2) return // nothing to arrange on a machine that adds fewer than two
      // Everything but the last folder, plus one duplicate: the same length as the full list
      const inherited = [added[0]!, ...added.slice(0, -1)]
      process.env.PATH = inherited.join(delimiter)
      const dirs = ensureToolPath().path.split(delimiter)
      expect(dirs).toContain(added.at(-1))
      expect(new Set(dirs).size).toBe(dirs.length)
    } finally {
      process.env.PATH = original
    }
  })

  it('whichTool returns the actual executable path (the same job as `which`)', () => {
    ensureToolPath()
    const found = whichTool('node')
    expect(found).toBeTruthy()
    // It does not matter which directory — it only has to actually exist
    expect(execFileSync(found!, ['--version'], { encoding: 'utf8' })).toMatch(/^v\d+/)
  })

  it('a nonexistent tool is null (so the caller can decide the guidance text)', () => {
    expect(whichTool('this-tool-does-not-exist')).toBeNull()
  })
})

/**
 * The login-shell probe against shells the test writes (docs/runtime-lessons.md PA1, PA2, PA6), so
 * it asserts something on every machine, CI included, where the real shell knows no tool.
 */
describe.skipIf(process.platform === 'win32')('the login-shell probe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-probe-'))
  function shell(name: string, body: string): string {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  it('a tool only the login shell knows is found from a bare PATH (PA1)', () => {
    const tools = join(dir, 'only-the-shell-knows')
    mkdirSync(tools, { recursive: true })
    const tool = join(tools, 'cc-probe-tool')
    writeFileSync(tool, '#!/bin/sh\n')
    chmodSync(tool, 0o755)
    const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL }
    try {
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
      process.env.SHELL = shell('knows-a-tool', `echo "noise from a .zshrc"\necho "__CC_PATH__:/usr/bin:${tools}"`)
      __resetToolPathCache()
      expect(whichTool('cc-probe-tool')).toBeNull()
      expect(ensureToolPath().source).toBe('shell')
      expect(whichTool('cc-probe-tool')).toBe(tool)
    } finally {
      process.env.PATH = saved.PATH
      process.env.SHELL = saved.SHELL
      __resetToolPathCache()
    }
  })

  it('a shell that never answers is cut off at the bound and the fallback is used (PA2)', () => {
    const hangs = shell('hangs', 'exec sleep 30')
    const began = Date.now()
    expect(probeLoginShell('darwin', { SHELL: hangs }, 300)).toEqual([])
    expect(Date.now() - began).toBeLessThan(3000)
  })

  it('a shell stopped by its terminal (SIGTTOU, SIGSTOP) is cut off too: SIGKILL ends a stopped process (PA2)', () => {
    const stops = shell('stops', 'kill -STOP $$\necho "__CC_PATH__:/never"')
    const began = Date.now()
    expect(probeLoginShell('linux', { SHELL: stops }, 300)).toEqual([])
    expect(Date.now() - began).toBeLessThan(3000)
  })

  it('Windows runs no probe at all, even with a SHELL that could run (PA6)', () => {
    const marker = join(dir, 'probe-ran')
    const records = shell('records', `touch "${marker}"\necho "__CC_PATH__:/somewhere"`)
    expect(probeLoginShell('win32', { SHELL: records })).toEqual([])
    expect(existsSync(marker)).toBe(false)
    // The same shell is run off Windows, so the marker means what it says
    expect(probeLoginShell('linux', { SHELL: records })).toEqual(['/somewhere'])
    expect(existsSync(marker)).toBe(true)
  })
})

/**
 * Windows (#14), simulated: the lookup takes the platform, the environment and the filesystem as
 * arguments, so it runs the same on every OS.
 */
describe('finding a tool on Windows', () => {
  const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm'
  // What `npm i -g @anthropic-ai/claude-code` leaves in that folder.
  const files = new Set([`${npm}\\claude`, `${npm}\\claude.cmd`, `${npm}\\claude.ps1`])
  const exists = (p: string) => files.has(p)

  it('returns the .cmd, not the sh script npm writes beside it under the bare name', () => {
    expect(whichTool('claude', { PATH: `C:\\Windows\\System32;${npm}` }, 'win32', exists)).toBe(`${npm}\\claude.cmd`)
  })

  it('tries the PATHEXT extensions in order, folder by folder', () => {
    const local = 'C:\\Users\\me\\.local\\bin'
    const both = new Set([`${local}\\claude.exe`, `${npm}\\claude.cmd`])
    const env = { PATH: `${local};${npm}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    expect(whichTool('claude', env, 'win32', (p) => both.has(p))).toBe(`${local}\\claude.exe`)
  })

  it('never searches a relative PATH entry, which would resolve against the working directory', () => {
    const planted = new Set(['bin\\git.exe', 'git.exe'])
    expect(whichTool('git', { PATH: 'bin;.' }, 'win32', (p) => planted.has(p))).toBeNull()
  })

  it('reads Path and Pathext whatever their case, as a copy of the Windows environment spells them', () => {
    expect(whichTool('claude', { Path: npm, Pathext: '.EXE;.CMD' }, 'win32', exists)).toBe(`${npm}\\claude.cmd`)
  })

  it('a name that already has an extension is looked up as it is', () => {
    expect(whichTool('claude.cmd', { PATH: npm }, 'win32', exists)).toBe(`${npm}\\claude.cmd`)
  })

  it('falls back to the folders Windows installers write to, not unix ones', () => {
    const dirs = fallbackDirs('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\me' }, 'C:\\Users\\me')
    expect(dirs).toContain(npm)
    expect(dirs).toContain('C:\\Users\\me\\.local\\bin')
    expect(dirs.some((d) => d.startsWith('/'))).toBe(false)
  })
})
