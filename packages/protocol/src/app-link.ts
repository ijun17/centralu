/**
 * 앱 링크 `centralu://app?url=<폴더나 zip의 주소>` (M4 E-4) — 누르면 가져오기 확인 창(E-3)이 그 출처를 채운 채 열린다.
 *
 * 링크는 **남이 지은 글**이다. 메일·채팅·웹 페이지의 링크를 누르면 OS가 이 앱에 건넨다. 그래서 여기서는 모양만 좁히고, 여는 일은
 * 사람이 확인 창에서 Review를 누른 뒤에만 한다(창이 먼저 읽거나 내려받지 않는다). host는 받은 출처를 자기 규칙으로 한 번 더 판정한다
 * (`apps/external/imports.ts` `classifySource`) — 이 파일은 화면이 어떤 링크를 창으로 올릴지만 정한다.
 *
 * 받는 것: `centralu://app?url=` 하나, 그 값은 `https:`(계정이 든 주소는 아니다) 또는 이 기계의 `file:`. 경로만 적은 값, http,
 * 다른 스킴은 받지 않는다. `url`이 둘이면 어느 쪽을 열지 모호하므로 받지 않는다. 모르는 다른 칸은 읽지 않는다(뒤의 판이 더할 수 있다).
 *
 * 화면(UI)과 host가 같이 쓰도록 여기 둔다 — 이 패키지는 둘이 함께 닿는 유일한 선반이다.
 */

export const APP_LINK_MAX_CHARS = 4096

export type AppLinkParse = { ok: true; source: string } | { ok: false; error: string }

export function parseAppLink(link: string): AppLinkParse {
  if (link.length > APP_LINK_MAX_CHARS) return { ok: false, error: `The link is longer than ${APP_LINK_MAX_CHARS} characters` }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(link)) return { ok: false, error: 'The link contains control characters' }
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return { ok: false, error: 'Not a link Centralu understands' }
  }
  if (url.protocol !== 'centralu:') return { ok: false, error: 'Not a centralu:// link' }
  if (url.host !== 'app' || (url.pathname !== '' && url.pathname !== '/')) {
    return { ok: false, error: 'Centralu links open apps: centralu://app?url=…' }
  }
  const values = url.searchParams.getAll('url')
  if (values.length !== 1) return { ok: false, error: values.length ? 'The link names more than one url' : 'The link names no url to import from' }
  const raw = values[0]!
  let inner: URL
  try {
    inner = new URL(raw)
  } catch {
    return { ok: false, error: `Not a link to import from: ${raw}` }
  }
  if (inner.protocol === 'https:') {
    if (inner.username || inner.password) return { ok: false, error: 'Links with a user name or password in them are not accepted' }
    return { ok: true, source: inner.href }
  }
  if (inner.protocol === 'file:') {
    if (inner.host !== '' && inner.host !== 'localhost') return { ok: false, error: 'Only files on this machine can be imported from a file link' }
    return { ok: true, source: inner.href }
  }
  return { ok: false, error: `Only https links and files on this machine can be imported: ${raw}` }
}
