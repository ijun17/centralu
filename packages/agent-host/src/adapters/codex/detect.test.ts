import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * codex CLI 본체는 `CODEX_HOME`을 존중하는데 우리 detect()만 홈 경로를 박아 쓰고 있었다 —
 * `CODEX_HOME`을 쓰는 사람에게 엉뚱한 폴더를 보고 로그인 여부를 답한다.
 *
 * 사용자의 진짜 `~/.codex`는 건드리지 않는다. 임시 디렉토리를 가리켜서 잰다.
 */
// promisify(execFile)가 진짜처럼 {stdout, stderr}로 풀리게 custom을 달아 준다
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

describe('codex detect()가 보는 설정 폴더', () => {
  it('CODEX_HOME 안에 auth.json이 있으면 로그인된 것으로 본다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
    writeFileSync(join(home, 'auth.json'), '{}')
    process.env.CODEX_HOME = home

    expect(await new CodexAdapter().detect()).toMatchObject({ installed: true, loggedIn: true })
  })

  it('CODEX_HOME이 비어 있으면 홈에 auth.json이 있어도 로그인 안 됨이다 (CLI와 같은 곳을 봐야 한다)', async () => {
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'codex-home-empty-'))

    const d = await new CodexAdapter().detect()

    expect(d).toMatchObject({ installed: true, loggedIn: false })
    expect(d.detail).toContain('login required')
  })

  it('빈 문자열은 지정하지 않은 것으로 친다 — 홈으로 되돌아간다', async () => {
    process.env.CODEX_HOME = '   '

    // 이 기계의 실제 로그인 상태에 따라 값이 갈리므로 "터지지 않고 답한다"까지만 본다
    expect(await new CodexAdapter().detect()).toMatchObject({ tool: 'codex', installed: true })
  })
})
