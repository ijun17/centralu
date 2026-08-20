import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { delimiter } from 'node:path'
import { ensureToolPath, whichTool } from './env-path.js'

/**
 * 배포 앱이 CLI를 못 찾던 문제의 회귀 테스트.
 *
 * 핵심은 "홈브류에 있어야만 찾는다"가 아니라 **사용자의 로그인 셸 PATH를 그대로 쓴다**는 것이다.
 * nvm·mise·수동 설치 등 어디에 깔려 있든 셸이 아는 곳이면 찾는다.
 */
describe('CLI 탐색 경로 보강', () => {
  it('GUI 앱의 빈약한 PATH에서도 셸이 아는 도구를 찾아낸다', () => {
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
      if (!toolPath) return // 셸에서도 못 찾으면 검증할 것이 없다
      const toolName = toolPath.split('/').pop()!

      // .app이 받는 빈약한 PATH — 이 상태에서는 도구를 못 찾는다
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
      expect(whichTool(toolName)).toBeNull()

      // 보강 후에는 찾는다 (홈브류든 nvm이든 어디에 깔렸든)
      ensureToolPath()
      expect(whichTool(toolName)).toBeTruthy()
    } finally {
      process.env.PATH = original
    }
  })

  it('이미 있는 경로를 중복해서 넣지 않는다', () => {
    const original = process.env.PATH
    try {
      const { path } = ensureToolPath()
      const dirs = path.split(delimiter)
      expect(new Set(dirs).size).toBe(dirs.length)
    } finally {
      process.env.PATH = original
    }
  })

  it('whichTool이 실제 실행 파일 경로를 돌려준다 (which와 같은 일)', () => {
    ensureToolPath()
    const found = whichTool('node')
    expect(found).toBeTruthy()
    // 어느 디렉토리든 상관없다 — 실제로 존재하기만 하면 된다
    expect(execFileSync(found!, ['--version'], { encoding: 'utf8' })).toMatch(/^v\d+/)
  })

  it('없는 도구는 null (호출자가 안내 문구를 정할 수 있게)', () => {
    expect(whichTool('이런도구는없다')).toBeNull()
  })
})
