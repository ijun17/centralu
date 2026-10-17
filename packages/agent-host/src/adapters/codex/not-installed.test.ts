import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './index.js'

/*
 * #838: with codex not on PATH, the adapter spawned the bare name `codex` in the project's folder, and Windows looks a
 * bare name up in the child's working folder before PATH: a codex.exe committed to the project ran when the project's
 * past Codex conversations were listed, before any trust. The planted one here is Node, which runs the script
 * `app-server` it finds there (the argument codex is started with) and leaves a mark.
 */
describe.skipIf(process.platform !== 'win32')('codex that is not installed', () => {
  let root = ''
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  it('fails to start, and the codex.exe in the project never runs', async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-codex-none-')))
    const bin = join(root, 'bin')
    const project = join(root, 'project')
    mkdirSync(bin)
    mkdirSync(project)
    try {
      linkSync(process.execPath, join(project, 'codex.exe'))
    } catch {
      copyFileSync(process.execPath, join(project, 'codex.exe'))
    }
    writeFileSync(join(project, 'package.json'), '{"type":"commonjs"}')
    writeFileSync(join(project, 'app-server'), "require('node:fs').writeFileSync('planted-ran', 'yes')\n")
    vi.stubEnv('PATH', bin)
    // Windows' default, which some shells (agent CLIs among them) turn off: the working directory is looked in first
    vi.stubEnv('NoDefaultCurrentDirectoryInExePath', undefined)
    await expect(new CodexAdapter().listExternalSessions(project, 5)).rejects.toThrow()
    expect(existsSync(join(project, 'planted-ran'))).toBe(false)
  })
})
