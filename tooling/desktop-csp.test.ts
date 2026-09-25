import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 데스크톱 창의 CSP (M4 B-3b, 스파이크 S-1).
 *
 * 앱 화면은 루프백의 샌드박스 프록시(`http://127.0.0.1:<host 포트>`)를 iframe으로 띄운다.
 * 원래 CSP에는 `frame-src`가 없어 `default-src 'self'`로 떨어졌고, 프록시 프레임이 막혔다
 * (S-1 실측). 포트는 고정할 수 없다. host가 `--port 0`으로 떠서 실행마다 번호가 바뀐다
 * (sidecar.rs). 그래서 `127.0.0.1:*`를 연다. 그 포트 위의 길은 모두 실행마다 새로 만든 비밀
 * 칸 뒤에 있다(transport/http.ts).
 *
 * **이보다 넓히지 않는다.** `*`나 `http:`를 열면 앱 화면이 아닌 아무 페이지도 우리 창 안에
 * 뜬다. `localhost`도 열지 않는다. 같은 루프백이지만 우리 프록시는 그 이름으로 주소를 만들지 않는다.
 *
 * 권한 쪽 규칙(S-2: `remote` 권한을 두지 않는다, 우리 명령은 창 `main`의 로컬 출처에만)은
 * desktop-permissions.test.ts가 지킨다.
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

function csp(): Map<string, string[]> {
  const conf = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')) as { app: { security: { csp: string } } }
  return new Map(
    conf.app.security.csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name = '', ...values] = d.split(/\s+/)
        return [name, values] as [string, string[]]
      }),
  )
}

describe('데스크톱 CSP', () => {
  it('프레임은 루프백 http 하나만 연다 — 포트는 실행마다 바뀌어 고정할 수 없다', () => {
    expect(csp().get('frame-src')).toEqual(['http://127.0.0.1:*'])
  })

  it('child-src·default-src로 프레임을 넓히는 우회가 없다', () => {
    const d = csp()
    expect(d.get('default-src')).toEqual(["'self'"])
    expect(d.has('child-src')).toBe(false)
  })

  it('우리 화면의 스크립트는 여전히 우리 것뿐이다', () => {
    expect(csp().get('script-src')).toEqual(["'self'"])
  })
})
