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
  it('runs the CLI by its Korean path and leaves the console on the code page it had', () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-launcher-')))
    dirs.push(base)
    const profile = join(base, '사용자')
    const data = join(profile, '.centralu')
    const cli = join(profile, 'npm', 'centralu.mjs')
    mkdirSync(data, { recursive: true })
    mkdirSync(dirname(cli), { recursive: true })
    writeFileSync(cli, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
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
    expect(JSON.parse(Buffer.from(lines[0]!, 'latin1').toString('utf8'))).toEqual(['serve', '한글'])
    // The launcher switched to UTF-8 for itself and back
    expect(lines[1]).toMatch(/\b437\b/)
  })
})
