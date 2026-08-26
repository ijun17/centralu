# 기술 스택 — 라이브러리 선택과 그 이유

> 영어 원본: [tech-stack.md](tech-stack.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

선정 기준은 제품 스펙 §7.1(가벼움)과 아키텍처의 변화 축이다: **런타임 오버헤드가 작을 것, 교체 가능한 위치에 있을 것, 활발히 유지보수될 것.** "일단 넣고 보는" 의존성은 없다 — 하나를 추가하려면 이 문서에 행을 추가해야 한다.

## 1. 프런트엔드 (packages/ui, apps/web)

| 영역 | 선택 | 이유 | 기각한 대안 |
|---|---|---|---|
| 프레임워크 | **React 19 + TypeScript** | 스펙 v0.4에서 확정. 에이전트 주도 개발에 친화적 | SolidJS/Svelte (v0.4에서 배제) |
| 빌드 | **Vite** | 웹 dev 모드의 핵심 도구, 공식 Tauri 템플릿과 호환 | — |
| 상태 | **zustand** | ~1KB, 보일러플레이트 없음, React 밖에서 구독 가능(이벤트 스트림 → store에 필수), selector 기반 리렌더 제어 | Redux Toolkit (무겁고 격식이 과함), Jotai (이벤트 스트림 적용에 부적합) |
| 리스트 가상화 | **@tanstack/react-virtual** | 대화 스트림, 파일 트리, 인박스 모두에 필요 (§7.1 60fps) | react-window (동적 높이 지원이 약함) |
| 마크다운 | **react-markdown** (remark) | 스트리밍 중 부분 파싱이 안전, 플러그인 생태계 | 직접 파싱 (범위 밖) |
| 코드 하이라이팅 | **Shiki** (지연 로드, web worker) | 정확도 최고; 코드 블록이 나타날 때까지 로딩을 미룸 | highlight.js (품질), Prism (유지보수) |
| 코드 뷰어/diff | **CodeMirror 6** (read-only + merge view) | Monaco의 1/10 크기, 대용량 파일 가상 스크롤 내장, diff 뷰 공식 지원 | Monaco (수 MB, 에디터 전체가 딸려 온다 — 필요한 것은 뷰어뿐) |
| 스타일링 | **Tailwind CSS v4** | 런타임 0, 다크 테마 토큰화가 쉬움 | CSS-in-JS 계열 (런타임 비용) |
| Headless UI | **Radix UI** (dialog, dropdown, tooltip만) | 접근성과 포커스 관리가 공짜, 필요한 프리미티브만 설치 | 풀 컴포넌트 킷 (디자인 종속) |
| 아이콘 | **lucide-react** | 완전한 tree-shaking 가능 | — |
| 날짜/시간 | **Intl API 직접 사용** + 직접 작성한 작은 헬퍼 | "3분째 대기 중" 수준에는 라이브러리가 필요 없다 | dayjs/date-fns (불필요한 의존성) |
| WS 클라이언트 | **native WebSocket** + 직접 작성한 재연결 래퍼(~50줄) | 요구사항이 단순하고(재연결 + backoff + token) 의존성이 줄어든다 | socket.io (프로토콜 오버헤드) |

## 2. 스키마와 검증 (packages/protocol)

| 영역 | 선택 | 이유 |
|---|---|---|
| 스키마 | **zod v4** | 타입 추론 = 런타임 검증, 단일 소스. 비용을 통제하기 위해 경계(WS 수신, invoke 응답)에서만 검증 |

## 3. Agent Host (packages/agent-host — Node 22+)

| 영역 | 선택 | 이유 | 기각한 대안 |
|---|---|---|---|
| Claude 연동 | **@anthropic-ai/claude-agent-sdk** | 스펙에서 확정. 스트리밍, resume, canUseTool | PTY 래핑 (스펙에서 기각) |
| Codex 연동 | **직접 작성한 JSON-RPC 클라이언트** (child_process + stdio) | `codex app-server`는 얇은 JSON-RPC — SDK에 의존하는 것보다 버전 변화(C4) 대응이 쉽다 | 서드파티 래퍼 (유지보수 불투명) |
| WS 서버 | **ws** | 사실상의 표준, 단독으로 충분 | Fastify 등 (HTTP 서버가 필요 없음) |
| dev store | **better-sqlite3** | 이 규모에서는 동기 API가 가장 단순하고 빠르다. dev 전용, prod에서는 rusqlite로 교체 | node:sqlite (아직 실험 단계) |
| dev git | **직접 작성한 git CLI spawn 래퍼** (`--porcelain=v2` 파싱) | prod에서 git2(Rust)로 교체할 임시 구현 — 얇을수록 버리기 쉽다 | simple-git (버릴 코드에 의존성 추가) |
| 파일 워처 | **chokidar** | dev 전용, debounce와 조합 | — |
| MCP 서버 | **@modelcontextprotocol/sdk** | 공식 SDK, 오케스트레이터용 (FR-11) | 직접 작성 (스펙을 추적하는 비용) |

## 4. Tauri 쪽 (apps/desktop/src-tauri — M1 이후)

| 영역 | 선택 | 이유 |
|---|---|---|
| 셸 | **Tauri 2.x** | 스펙에서 확정 |
| git | **git2** crate | 스펙에서 확정 (FR-4), 프로세스 spawn 없이 조회 |
| 저장소 | **rusqlite** (bundled) | StorePort의 prod 구현 |
| 파일 워처 | **notify** crate | 앱 레벨에서 debounce |
| OS 연동 | tauri-plugin-notification / global-shortcut / dialog / opener | 공식 플러그인 우선, 직접 작성은 최소화 |

## 5. 개발 도구

| 영역 | 선택 | 이유 |
|---|---|---|
| 모노레포 | **pnpm workspaces** (단독) | 이 규모에서 Turbo/Nx는 불필요 — 느려지면 그때 |
| 테스트 | **Vitest** | Vite와 설정 공유; core/protocol/어댑터 계약 테스트 |
| E2E | **Playwright** | 웹 dev 모드를 대상 그대로 직접 테스트 |
| 린트 | **ESLint (flat) + eslint-plugin-boundaries** | 레이어 규칙을 기계로 강제한다 (아키텍처 §2) — Biome이 아니라 ESLint인 이유 |
| 포맷 | **Prettier** | 논쟁을 끝내기 위해 |
| 의존성 그래프 검증 | **dependency-cruiser** (CI) | boundaries가 잡지 못하는 패키지 간 규칙의 2차 방어선 |

## 6. 금지 목록 (추가하려면 이 문서에서 논리로 이겨야 한다)

- **Electron 계열 전부** — 스펙의 전제 위반
- **Monaco** — 크기. 뷰어에 에디터를 넣지 않는다
- **moment/dayjs/date-fns** — Intl로 충분
- **axios** — UI에서는 fetch조차 금지인데 하물며 이것은
- **Redux + 미들웨어 생태계** — zustand로 충분, 크기와 격식 비용
- **CSS-in-JS 런타임** (emotion, styled-components) — §7.1 위반
- **ORM** (Prisma, Drizzle) — 테이블 6개면 마이그레이션은 SQL 파일로 충분
