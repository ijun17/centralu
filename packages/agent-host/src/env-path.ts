import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * GUI 앱의 PATH를 **사용자의 실제 PATH**로 맞춘다.
 *
 * **왜 필요한가 (실측):** macOS에서 `.app`으로 실행하면 로그인 셸의 PATH를 물려받지 못해
 * `/usr/bin:/bin:/usr/sbin:/sbin`만 들어온다. 그래서 `claude`·`codex`가 "설치되지 않음"으로
 * 잡히고 세션 생성 다이얼로그의 시작 버튼이 아무 반응도 하지 않는 것처럼 보였다.
 *
 * **어떻게:** 정적 경로 목록으로는 부족하다 — 에이전트 도구는 homebrew뿐 아니라 npm -g,
 * nvm, volta, mise, asdf, 수동 설치 등 어디에나 있을 수 있다.
 * 그래서 **사용자의 로그인 셸을 한 번 실행해 진짜 PATH를 물어본다.** 셸 설정(.zshrc 등)에
 * 무엇이 적혀 있든 그대로 반영된다.
 * 실패하거나 느리면 아래 정적 후보로 폴백한다 (아예 못 찾는 것보다는 낫다).
 */

/** 셸을 못 쓸 때의 폴백. 흔한 설치 위치만 */
const FALLBACK = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  join(homedir(), '.local/bin'),
  join(homedir(), '.bun/bin'),
  join(homedir(), '.volta/bin'),
  join(homedir(), '.cargo/bin'),
  join(homedir(), 'Library/pnpm'),
]

/** 로그인 셸에게 PATH를 묻는다. 대화형(-i)이어야 .zshrc의 nvm/mise 초기화까지 반영된다 */
function loginShellPath(): string[] {
  const shell = process.env.SHELL
  if (!shell || !existsSync(shell)) return []
  try {
    const out = execFileSync(shell, ['-ilc', 'command -p echo "__CC_PATH__:$PATH"'], {
      encoding: 'utf8',
      timeout: 3000,
      // SIGTERM을 무시하는 셸이 있어 SIGKILL로 확실히 끊는다 —
      // 여기서 멈추면 host가 ready를 못 찍고 앱이 통째로 기동 실패한다
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
      // 셸 초기화 스크립트가 대화형 프롬프트를 띄우지 않도록
      env: { ...process.env, TERM: 'dumb', CI: '1' },
    })
    // 셸 설정이 뭔가를 출력할 수 있으므로 표식이 붙은 줄만 고른다
    const line = out.split('\n').find((l) => l.startsWith('__CC_PATH__:'))
    return line ? line.slice('__CC_PATH__:'.length).split(delimiter).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * PATH를 보강하고 결과를 돌려준다. 호스트 기동 시 한 번만 호출한다.
 * 터미널에서 `pnpm host`로 띄울 때는 이미 제대로 된 PATH가 있으므로 사실상 무해하다.
 */
export function ensureToolPath(): { path: string; source: 'shell' | 'fallback' | 'unchanged' } {
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean)

  const fromShell = loginShellPath()
  const source = fromShell.length > 0 ? 'shell' : 'fallback'
  const candidates = fromShell.length > 0 ? fromShell : FALLBACK.filter((p) => existsSync(p))

  // 셸이 준 목록 자체에 중복이 있을 수 있다 — 순서를 지키며 한 번씩만 남긴다
  const merged = [...new Set([...current, ...candidates])]
  if (merged.length === current.length) return { path: process.env.PATH ?? '', source: 'unchanged' }

  process.env.PATH = merged.join(delimiter)
  return { path: process.env.PATH, source }
}

/**
 * 도구의 실제 경로를 찾는다 (`which`와 같은 일).
 * 어디에 설치됐는지 사용자에게 보여줄 수 있어야 "왜 못 찾지"를 스스로 풀 수 있다.
 */
export function whichTool(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}
