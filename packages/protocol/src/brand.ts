/**
 * 앱을 식별하는 값들.
 *
 * **여기 있는 것은 "기계가 읽는 값"만이다.** 화면에 보이는 문구는 리터럴로 둔다 —
 * `${APP_NAME}는 …`보다 `Centralu는 …`가 읽기 좋고, 다국어가 필요해지면 상수 참조가
 * 아니라 문자열 카탈로그로 가야 하기 때문이다.
 *
 * 상수로 뺀 기준은 하나다: **중복되어 있고, 어긋나도 빌드가 통과하는 값.**
 * 그리고 TypeScript가 닿지 못하는 곳(index.html · tauri.conf.json · Cargo.toml · Rust)은
 * 상수로 묶을 수 없으므로 계약 테스트가 지킨다 (`tooling/brand.test.ts`).
 */

/** 사람에게 보이는 이름. 정적 파일들이 이 값과 같은지는 계약 테스트가 확인한다 */
export const APP_NAME = 'Centralu'

/** 번들 식별자 — `tauri.conf.json`의 identifier와 같아야 한다 */
export const APP_ID = 'app.centralu'

/** 세 곳(tauri.conf.json · Cargo.toml · apps/desktop/package.json)이 이 값과 같아야 한다 */
export const APP_VERSION = '0.1.0'

/** 기계가 읽는 이름 — 표시용과 달리 소문자·하이픈 형태를 지킨다 */
export const APP_SLUG = 'centralu'

/**
 * 외부 CLI에 자기를 소개할 때 넘기는 덩어리 (codex `clientInfo`).
 * 다섯 군데에서 같은 것을 만들고 있었고, 버전만 손대면 조용히 어긋나던 자리다.
 */
export const CLIENT_INFO = { name: APP_SLUG, title: APP_NAME, version: APP_VERSION } as const

/**
 * 데이터 폴더 이름.
 *
 * **앱 이름을 바꿔도 이것만은 그대로 둔다.** 여기에 이미 사용자의 대화 기록이 들어 있고
 * (`store.db`), 폴더 이름을 바꾸는 순간 그 기록이 통째로 안 보이게 된다. 마이그레이션을
 * 붙일 만한 이득이 없다 — 사용자가 이 경로를 볼 일은 로그를 첨부할 때뿐이다.
 */
export const DATA_DIR = '.control-center'

/** dev로 띄운 host의 데이터 폴더 — 배포 앱과 섞이지 않게 갈라 둔다 */
export const DATA_DIR_DEV = '.control-center-dev'
