import { describe, expect, it, vi } from 'vitest'

/**
 * `claude --version`은 인증을 보지 않는다 — 자격이 하나도 없어도 성공한다.
 * 그래서 예전 detect()는 "깔려 있음"을 곧 "로그인됨"으로 답했고, 로그인 안 된 Claude가
 * 화면에서 늘 '준비됨'으로 보였다 (#11). 여기서는 CLI를 가짜로 갈아 끼워
 * **detect()가 인증을 실제로 물어보는지**만 본다 — 진짜 CLI를 부르면 사용자의 로그인
 * 상태에 따라 결과가 흔들려서 테스트가 아무것도 못 정한다.
 */
const cli = vi.hoisted(() => ({
  /** 인자 배열을 받아 stdout을 주거나, 던진다 (던지면서 stdout을 달고 갈 수도 있다) */
  run: (_args: string[]): { stdout: string } => ({ stdout: '' }),
}))

// 어댑터는 promisify(execFile)로 부른다 — 진짜 execFile처럼 {stdout, stderr}로 풀리도록
// promisify.custom을 달아 준다. 안 그러면 promisify가 첫 인자(문자열)만 돌려준다.
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

/** 종료 코드 1로 죽었지만 stdout에는 JSON을 남긴 CLI를 흉내낸다 */
function failWithStdout(stdout: string): never {
  throw Object.assign(new Error('Command failed'), { stdout })
}

describe('claude detect()의 로그인 판정', () => {
  it('auth status가 loggedIn:false면 그대로 로그인 안 됨으로 올린다 (#11의 본체)', async () => {
    cli.run = (args) =>
      args[0] === '--version'
        ? { stdout: '2.1.223 (Claude Code)\n' }
        : { stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) }

    const d = await new ClaudeAdapter().detect()

    expect(d).toMatchObject({ tool: 'claude', installed: true, loggedIn: false })
    expect(d.detail).toContain('login required')
  })

  it('로그인 안 됐을 때 auth status는 종료 코드 1로 죽는다 — 그래도 stdout의 JSON을 읽는다', async () => {
    cli.run = (args) =>
      args[0] === '--version'
        ? { stdout: '2.1.223 (Claude Code)\n' }
        : failWithStdout(JSON.stringify({ loggedIn: false }))

    expect(await new ClaudeAdapter().detect()).toMatchObject({ installed: true, loggedIn: false })
  })

  it('로그인돼 있으면 통과시키고 detail에 군더더기를 붙이지 않는다', async () => {
    cli.run = (args) =>
      args[0] === '--version'
        ? { stdout: '2.1.223 (Claude Code)\n' }
        : { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) }

    const d = await new ClaudeAdapter().detect()

    expect(d).toMatchObject({ installed: true, loggedIn: true })
    expect(d.detail).not.toContain('login required')
  })

  it('auth 하위 명령을 모르는 옛 CLI는 "모름"이지 "로그인 안 됨"이 아니다 — 통과시킨다', async () => {
    // 틀린 "로그인 안 됨"은 멀쩡한 것을 고치게 만들어서 지금 상태보다 나쁘다
    cli.run = (args) => {
      if (args[0] === '--version') return { stdout: '1.0.0 (Claude Code)\n' }
      failWithStdout("error: unknown command 'auth'")
    }

    expect(await new ClaudeAdapter().detect()).toMatchObject({ installed: true, loggedIn: true })
  })

  it('인증을 물어보느라 추론 호출(-p)을 태우지 않는다 — 앱을 켤 때마다 과금되면 안 된다', async () => {
    const calls: string[][] = []
    cli.run = (args) => {
      calls.push(args)
      return args[0] === '--version' ? { stdout: '2.1.223\n' } : { stdout: '{"loggedIn":true}' }
    }

    await new ClaudeAdapter().detect()

    expect(calls).toEqual([['--version'], ['auth', 'status', '--json']])
    expect(calls.flat()).not.toContain('-p')
  })

  it('CLI가 아예 없으면 예전처럼 미설치로 답한다', async () => {
    cli.run = () => {
      throw new Error('ENOENT')
    }

    expect(await new ClaudeAdapter().detect()).toMatchObject({ installed: false, loggedIn: false })
  })
})
