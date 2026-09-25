import { APP_ID_MAX_LENGTH, APP_SERVER_PREFIX, RESERVED_NAME_PREFIX, type NewAppIdProblem } from '@cc/protocol'

/**
 * "New app" 창의 id (M4 C-1) — 사람이 적은 이름에서 짓고, host와 같은 판정(`newAppIdProblem`)을 받는다.
 *
 * id는 폴더 이름이자 세션에서 `app-<id>`가 되는 이름이라 사람이 적은 이름을 그대로 쓸 수 없다. 그렇다고 id를 먼저
 * 묻으면 사람은 규칙부터 배워야 한다. 그래서 이름에서 짓고, 지은 것을 보여 주고, 고칠 수 있게 둔다. 짓는 규칙은
 * 판정이 통과시킬 모양으로 좁힌다: 소문자, 영숫자 밖의 글자는 하이픈 하나로, 앞뒤 하이픈 없이, 32자까지.
 * 한글처럼 영숫자로 바꿀 수 없는 이름은 빈 id가 된다 — 지어낸 id보다 "직접 적어 달라"가 정직하다.
 */
export function deriveAppId(name: string): string {
  const slug = name
    // 악센트는 떼고 글자는 남긴다 — "Café"는 "cafe"다
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // 자른 끝이 하이픈이면 그것도 뗀다 — 규칙은 끝의 하이픈을 막지 않지만 "notes-"는 지은 id로 어색하다
  return slug.slice(0, APP_ID_MAX_LENGTH).replace(/-+$/, '')
}

/**
 * 판정에 걸린 까닭을 창 앞의 사람에게 — host의 말(에이전트와 로그를 위한 한국어)과 판정은 같고 말만 다르다.
 * 빈 id는 따로 말한다: 규칙을 어긴 것이 아니라 아직 적지 않은 것이다.
 */
export function appIdHint(id: string, problem: NewAppIdProblem): string {
  if (id === '') return 'Give the app an id: lowercase letters, digits and hyphens.'
  switch (problem) {
    case 'shape':
      return `Use lowercase letters, digits and hyphens (up to ${APP_ID_MAX_LENGTH}), starting with a letter or digit.`
    case 'reserved':
      return `Ids starting with "${RESERVED_NAME_PREFIX}" belong to Centralu itself.`
    case 'server-prefix':
      return `Ids starting with "${APP_SERVER_PREFIX}" are how apps attach to sessions. Pick another.`
    case 'builtin':
      return `"${id}" is a built-in app.`
  }
}
