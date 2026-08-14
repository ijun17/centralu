# 기술 스택 — 라이브러리 선정과 근거

선정 기준은 기획서 §7.1(가벼움)과 아키텍처 변경 축이다: **런타임 오버헤드가 작고, 교체 가능한 위치에 있고, 유지보수가 활발할 것.** "일단 넣고 보는" 의존성 금지 — 추가하려면 이 문서에 행을 추가해야 한다.

## 1. 프론트엔드 (packages/ui, apps/web)

| 영역 | 선택 | 근거 | 기각한 대안 |
|---|---|---|---|
| 프레임워크 | **React 19 + TypeScript** | 기획서 v0.4 확정. 에이전트 기반 개발 친화성 | SolidJS/Svelte (v0.4에서 종결) |
| 빌드 | **Vite** | 웹 dev 모드의 핵심 도구, Tauri 공식 템플릿과 호환 | — |
| 상태 | **zustand** | ~1KB, 보일러플레이트 없음, React 외부에서 구독 가능(이벤트 스트림→스토어에 필수), 셀렉터 기반 리렌더 제어 | Redux Toolkit (무겁고 의식이 많음), Jotai (이벤트 스트림 적용에 부적합) |
| 리스트 가상화 | **@tanstack/react-virtual** | 대화 스트림·파일 트리·인박스 전부 필요 (§7.1 60fps) | react-window (역동적 높이 지원 약함) |
| 마크다운 | **react-markdown** (remark) | 스트리밍 중 부분 파싱 안전, 플러그인 생태계 | 직접 파싱 (범위 아님) |
| 코드 하이라이트 | **Shiki** (lazy-load, 웹워커) | 정확도 최고, 로드는 코드블록 등장 시로 지연 | highlight.js (품질), Prism (유지보수) |
| 코드 뷰어/diff | **CodeMirror 6** (read-only + merge view) | Monaco 대비 1/10 크기, 대용량 가상 스크롤 내장, diff 뷰 공식 지원 | Monaco (수 MB, 편집기 전체가 딸려옴 — 뷰어만 필요) |
| 스타일 | **Tailwind CSS v4** | 런타임 0, 다크 테마 토큰화 용이 | CSS-in-JS 계열 (런타임 비용) |
| 헤드리스 UI | **Radix UI** (dialog, dropdown, tooltip만) | 접근성·포커스 관리 공짜, 필요한 프리미티브만 개별 설치 | 전체 컴포넌트 킷 (디자인 종속) |
| 아이콘 | **lucide-react** | 트리셰이킹 완전 | — |
| 날짜/시간 | **Intl API 직접** + 소형 헬퍼 자작 | "3분째 대기 중" 수준에 라이브러리 불필요 | dayjs/date-fns (불필요 의존) |
| WS 클라이언트 | **네이티브 WebSocket** + 재연결 래퍼 자작 (~50줄) | 요구가 단순(재연결+백오프+토큰), 의존 줄임 | socket.io (프로토콜 오버헤드) |

## 2. 스키마·검증 (packages/protocol)

| 영역 | 선택 | 근거 |
|---|---|---|
| 스키마 | **zod v4** | 타입 추론 = 런타임 검증 단일 소스. 경계(WS 수신, invoke 응답)에서만 검증해 비용 통제 |

## 3. Agent Host (packages/agent-host — Node 22+)

| 영역 | 선택 | 근거 | 기각한 대안 |
|---|---|---|---|
| Claude 연동 | **@anthropic-ai/claude-agent-sdk** | 기획서 확정. 스트리밍·resume·canUseTool | PTY 래핑 (기획서에서 기각) |
| Codex 연동 | **자작 JSON-RPC 클라이언트** (child_process + stdio) | `codex app-server`는 얇은 JSON-RPC — SDK 의존보다 버전 변동(C4) 대응이 쉬움 | 서드파티 래퍼 (유지보수 불명) |
| WS 서버 | **ws** | 사실상 표준, 단독으로 충분 | Fastify 등 (HTTP 서버 불필요) |
| dev store | **better-sqlite3** | 동기 API가 이 규모에 단순·최속. prod에서 rusqlite로 대체되는 dev 전용 | node:sqlite (아직 실험적) |
| dev git | **git CLI spawn 자작 래퍼** (`--porcelain=v2` 파싱) | prod에서 git2(Rust)로 대체될 임시 구현 — 얇을수록 버리기 쉽다 | simple-git (버릴 코드에 의존 추가) |
| 파일 워처 | **chokidar** | dev 전용, debounce 조합 | — |
| MCP 서버 | **@modelcontextprotocol/sdk** | 공식 SDK, 오케스트레이터(FR-11)용 | 자작 (스펙 추적 비용) |

## 4. Tauri 측 (apps/desktop/src-tauri — M1 이후)

| 영역 | 선택 | 근거 |
|---|---|---|
| 셸 | **Tauri 2.x** | 기획서 확정 |
| git | **git2** crate | 기획서 확정 (FR-4), 프로세스 spawn 없이 조회 |
| 저장 | **rusqlite** (bundled) | StorePort의 prod 구현 |
| 파일 워처 | **notify** crate | debounce는 앱 레벨 |
| OS 통합 | tauri-plugin-notification / global-shortcut / dialog / opener | 공식 플러그인 우선, 자작 최소화 |

## 5. 개발 도구

| 영역 | 선택 | 근거 |
|---|---|---|
| 모노레포 | **pnpm workspaces** (단독) | 이 규모에 Turbo/Nx 불필요 — 느려지면 그때 |
| 테스트 | **Vitest** | Vite와 설정 공유, core/protocol/어댑터 계약 테스트 |
| E2E | **Playwright** | 웹 dev 모드를 그대로 테스트 대상으로 |
| 린트 | **ESLint(flat) + eslint-plugin-boundaries** | 레이어 규칙을 기계로 강제 (architecture §2) — 이것 때문에 Biome이 아닌 ESLint |
| 포맷 | **Prettier** | 논쟁 종결용 |
| 의존 그래프 검증 | **dependency-cruiser** (CI) | boundaries가 못 잡는 패키지 간 규칙 이중 방어 |

## 6. 금지 목록 (추가하려면 이 문서에서 근거로 이겨야 함)

- **Electron 계열 무엇이든** — 기획 전제 위반
- **Monaco** — 크기. 뷰어에 편집기를 넣지 않는다
- **moment/dayjs/date-fns** — Intl로 충분
- **axios** — fetch도 UI에선 금지인데 하물며
- **Redux + 미들웨어 생태계** — zustand로 충분, 사이즈와 의식 비용
- **CSS-in-JS 런타임** (emotion, styled-components) — §7.1 위반
- **ORM** (Prisma, Drizzle) — 테이블 6개에 마이그레이션은 SQL 파일이면 된다
