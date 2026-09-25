import { describe, expect, it } from 'vitest'
import { APP_LINK_MAX_CHARS, parseAppLink } from './app-link.js'

/**
 * 앱 링크 (M4 E-4) — 남이 지은 글이 가져오기 창으로 올라가는 문. 여기서는 모양만 본다: 여는 일은 사람이 창에서 누른 뒤에 host가
 * 제 규칙으로 다시 판정한다(`apps/external/imports.test.ts`).
 */
describe('parseAppLink', () => {
  it('https의 zip과 이 기계의 file: 주소를 출처로 꺼낸다', () => {
    expect(parseAppLink('centralu://app?url=https://example.com/notes.zip')).toEqual({ ok: true, source: 'https://example.com/notes.zip' })
    expect(parseAppLink('centralu://app?url=https%3A%2F%2Fexample.com%2Fa%20b.zip')).toEqual({ ok: true, source: 'https://example.com/a%20b.zip' })
    expect(parseAppLink('centralu://app/?url=file:///Users/me/Downloads/notes.zip')).toEqual({ ok: true, source: 'file:///Users/me/Downloads/notes.zip' })
    // URL 규칙이 localhost를 비운다 — host의 fileURLToPath가 읽는 모양 그대로다
    expect(parseAppLink('centralu://app?url=file://localhost/tmp/app')).toEqual({ ok: true, source: 'file:///tmp/app' })
    // 모르는 칸은 읽지 않는다 — 뒤의 판이 더할 수 있다
    expect(parseAppLink('centralu://app?url=https://example.com/a.zip&from=chat')).toEqual({ ok: true, source: 'https://example.com/a.zip' })
  })

  it('다른 스킴·다른 자리·url이 없거나 둘인 링크는 받지 않는다', () => {
    for (const [link, error] of [
      ['https://example.com/a.zip', 'Not a centralu:// link'],
      ['centralu://settings?url=https://example.com/a.zip', 'Centralu links open apps: centralu://app?url=…'],
      ['centralu://app/other?url=https://example.com/a.zip', 'Centralu links open apps: centralu://app?url=…'],
      ['centralu://app', 'The link names no url to import from'],
      ['centralu://app?url=https://a.test/1.zip&url=https://b.test/2.zip', 'The link names more than one url'],
      ['not a link', 'Not a link Centralu understands'],
    ] as const) {
      expect(parseAppLink(link), link).toEqual({ ok: false, error })
    }
  })

  it('출처는 https와 이 기계의 파일뿐이다 — http·다른 스킴·경로만 적은 값·계정이 든 주소·남의 기계의 file:은 받지 않는다', () => {
    for (const [inner, error] of [
      ['http://example.com/a.zip', 'Only https links and files on this machine can be imported: http://example.com/a.zip'],
      ['javascript:alert(1)', 'Only https links and files on this machine can be imported: javascript:alert(1)'],
      ['smb://server/share/a.zip', 'Only https links and files on this machine can be imported: smb://server/share/a.zip'],
      ['/Users/me/app', 'Not a link to import from: /Users/me/app'],
      ['https://user:pw@example.com/a.zip', 'Links with a user name or password in them are not accepted'],
      ['file://fileserver/share/a.zip', 'Only files on this machine can be imported from a file link'],
    ] as const) {
      expect(parseAppLink(`centralu://app?url=${encodeURIComponent(inner)}`), inner).toEqual({ ok: false, error })
    }
  })

  it('너무 긴 링크와 제어 문자가 든 링크는 받지 않는다', () => {
    expect(parseAppLink(`centralu://app?url=https://example.com/${'a'.repeat(APP_LINK_MAX_CHARS)}`)).toEqual({
      ok: false,
      error: `The link is longer than ${APP_LINK_MAX_CHARS} characters`,
    })
    expect(parseAppLink('centralu://app?url=https://example.com/a.zip\n')).toEqual({ ok: false, error: 'The link contains control characters' })
  })
})
