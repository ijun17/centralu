import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AppId, AppModule } from './contract.js'

/**
 * 앱 id가 다시 닫히지 않게 (M4 P-1).
 *
 * 실행 중에 알게 된 이름(여기서는 JSON에서 읽은 문자열)으로 앱 모듈을 세우는 것이 외부 앱이
 * 명부에 서는 모양 그대로다. 합집합이 다시 닫히면 이 파일이 컴파일되지 않는다 — 검사는
 * `tsc -b`가 한다. vitest는 타입을 보지 않으므로, 실행 쪽 단언은 값이 그대로 실렸다는 것뿐이다.
 */
describe('앱 id는 열린 문자열이다', () => {
  it('빌드가 모르는 이름으로도 앱 모듈을 세울 수 있다', () => {
    const discovered: string = JSON.parse('"resource-search"')
    const mod: AppModule = { id: discovered, title: 'Resource search' }

    expectTypeOf<AppId>().toEqualTypeOf<string>()
    expect(mod.id).toBe('resource-search')
  })
})
