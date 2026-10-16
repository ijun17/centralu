import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { ensureLauncher } from '../packaging/npm/centralu/bin/serve.mjs'

/**
 * `<data>\bin\centralu.cmd`, the launcher `centralu serve` writes for ssh, run the way ssh's default shell runs it: by
 * cmd.exe, with a PATH that has nothing on it. The file is UTF-8 and cmd.exe reads it in the console's code page (949 on
 * a Korean Windows, 437 on CI), so a profile folder named in Korean sent node to a path that was not there (#849).
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

describe.skipIf(process.platform !== 'win32')('the Windows launcher in a folder named in Korean', () => {
  it('runs the CLI by its Korean path, on the console code page it had, and leaves that page set', () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-launcher-')))
    dirs.push(base)
    const profile = join(base, '사용자')
    const data = join(profile, '.centralu')
    const cli = join(profile, 'npm', 'centralu.mjs')
    mkdirSync(data, { recursive: true })
    mkdirSync(dirname(cli), { recursive: true })
    // The CLI says what it got and which code page the console is on while it runs
    writeFileSync(
      cli,
      "import { execFileSync } from 'node:child_process'\n" +
        "const page = execFileSync(process.env.SystemRoot + '\\\\System32\\\\chcp.com').toString('latin1').trim()\n" +
        'console.log(JSON.stringify({ argv: process.argv.slice(2), page }))\n',
    )
    const file = ensureLauncher(data, { cliPath: cli }) as string
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const chcp = join(systemRoot, 'System32', 'chcp.com')

    const env = { PATH: '', SystemRoot: systemRoot }
    // The console is this test's runner's: what it was is put back whatever happens. A terminal may already be on
    // UTF-8 (65001), where the bug does not show, so the launcher runs on 437, the OEM code page of an English Windows
    const codePage = () => /(\d+)\D*$/.exec(spawnSync(chcp, { env }).stdout.toString('latin1').trim())?.[1]
    const before = codePage()
    expect(before, 'chcp names the console code page').toMatch(/^\d+$/)
    let r
    try {
      r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${chcp} 437 >nul & call "${file}" serve 한글 & ${chcp}"`], {
        windowsVerbatimArguments: true,
        env,
      })
    } finally {
      spawnSync(chcp, [before!], { env })
    }
    // node prints UTF-8 whatever the console's code page, so the line is decoded as that
    const lines = r.stdout.toString('latin1').split(/\r?\n/).filter(Boolean)
    expect(r.stderr.toString('utf8')).toBe('')
    expect(r.status).toBe(0)
    expect(lines).toHaveLength(2)
    const ran = JSON.parse(Buffer.from(lines[0]!, 'latin1').toString('utf8')) as { argv: string[]; page: string }
    expect(ran.argv).toEqual(['serve', '한글'])
    // UTF-8 only while cmd.exe read the line with the paths: the page was back before node ran, so a Ctrl+C that ends
    // the batch job at "Terminate batch job (Y/N)?" leaves the console as it was
    expect(ran.page).toMatch(/\b437\b/)
    expect(lines[1]).toMatch(/\b437\b/)
  })
})
