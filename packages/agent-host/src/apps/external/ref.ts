/**
 * 앱 하나를 가리키는 이름 — (범위, id). 앱 id는 범위 안에서만 하나다: 두 프로젝트의 `notes`는 다른 앱이다.
 * `projectId`가 null이면 사용자 폴더의 앱이다.
 *
 * 런타임의 문(`runtime.ts`)과 중개 창구(`desk.ts`)가 함께 쓴다 — 한쪽이 다른 쪽을 임포트하면 고리가 된다.
 */
export type AppRef = { projectId: string | null; appId: string }
