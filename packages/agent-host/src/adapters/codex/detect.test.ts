import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

const original = process.env.CODEX_HOME
afterEach(() => {
  if (original === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = original
})

describe('the settings folder codex detect() looks at', () => {
  it('treats an auth.json inside CODEX_HOME as being logged in', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    writeFileSync(join(home, 'auth.json'), '{}')
    process.env.CODEX_HOME = home

    expect(await new CodexAdapter().detect()).toMatchObject({ installed: true, loggedIn: true })
  })

  it('when CODEX_HOME is empty, not logged in even if the real home has an auth.json (must look at the same place as the CLI)', async () => {
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'codex-home-empty-'))

    const d = await new CodexAdapter().detect()

    expect(d).toMatchObject({ installed: true, loggedIn: false })
    expect(d.detail).toContain('login required')
  })

  it('treats an empty string as unset — falls back to the home folder', async () => {
    process.env.CODEX_HOME = '   '

    // The actual value depends on this machine's real login state, so this only checks that "it answers without breaking"
    expect(await new CodexAdapter().detect()).toMatchObject({ tool: 'codex', installed: true })
  })
})
