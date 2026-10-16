import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * The codex CLI itself honors `CODEX_HOME`, but our own detect() was hard-coding the home path —
 * answering a person using `CODEX_HOME` about login status by looking at the wrong folder.
 *
 * The user's real `~/.codex` is never touched. This measures by pointing at a temporary directory instead.
 */
// Attaches a custom so promisify(execFile) resolves with {stdout, stderr} just like the real thing
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile = async () => ({ stdout: 'codex-cli 0.147.0\n', stderr: '' })
  return { execFile: Object.assign(execFile, { [promisify.custom]: execFile }) }
})

vi.mock('../../env-path.js', () => ({ whichTool: () => '/usr/local/bin/codex' }))

const { CodexAdapter } = await import('./index.js')


describe('the settings folder codex detect() looks at', () => {
  it('treats an auth.json inside CODEX_HOME as being logged in', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    writeFileSync(join(home, 'auth.json'), '{}')
    vi.stubEnv('CODEX_HOME', home)

    expect(await new CodexAdapter().detect()).toMatchObject({ installed: true, loggedIn: true })
  })

  it('when CODEX_HOME is empty, not logged in even if the real home has an auth.json (must look at the same place as the CLI)', async () => {
    vi.stubEnv('CODEX_HOME', mkdtempSync(join(tmpdir(), 'codex-home-empty-')))

    const d = await new CodexAdapter().detect()

    expect(d).toMatchObject({ installed: true, loggedIn: false })
    expect(d.detail).toContain('login required')
  })

  /*
   * The home folder is a temporary one here (#845): this used to read the person's real `~/.codex`, so it could only
   * check that detect() answered, whatever this machine's login state was.
   */
  it('treats an empty string as unset — falls back to the home folder', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-user-home-'))
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'auth.json'), '{}')
    // os.homedir() reads HOME on macOS and Linux, USERPROFILE on Windows
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    expect(homedir()).toBe(home)
    vi.stubEnv('CODEX_HOME', '   ')

    expect(await new CodexAdapter().detect()).toMatchObject({ tool: 'codex', installed: true, loggedIn: true })
  })
})
