# Centralu

> 여러 에이전트 코딩 도구(Claude Code, Codex CLI)를 한 창에서 실행·관찰·제어하는 경량 데스크톱 앱

macOS · Apple Silicon 전용 · 베타. 대화 기록은 **당신의 맥에만** 저장된다
(`~/.control-center/store.db`). 어디로도 전송되지 않는다.

## 쓰려면 필요한 것

이 앱은 혼자 돌지 않는다. 아래가 없으면 앱이 뜨더라도 세션을 만들 수 없다.

| | |
|---|---|
| **Node 22 이상** | host(사이드카)가 이 위에서 돈다. 없으면 기동 화면이 무엇이 없는지 말해준다 |
| **`claude` CLI** + 로그인 | Claude Code 세션용 (`npm i -g @anthropic-ai/claude-code`) |
| **`codex` CLI** + 로그인 | Codex 세션용 (`npm i -g @openai/codex`). 안 쓸 거면 없어도 된다 |

첫 실행 화면이 이 셋의 상태를 직접 보여주고, 없는 것은 설치 명령까지 함께 적는다.

## 설치

npm 배포를 준비 중이다. 그때까지는 소스에서 빌드한다:

```bash
pnpm install && pnpm app        # 빌드 후 앱이 열린다
```

> 왜 npm인가: 브라우저로 받은 파일에는 macOS가 격리 딱지를 붙여 "확인할 수 없습니다"
> 경고가 뜬다. npm으로 설치한 것에는 그 딱지가 붙지 않아 경고 없이 그냥 열린다.
> 근거와 실측은 [배포 점검표 §2](docs/plans/beta-release-checklist.md)에 있다.

## 라이선스

[MIT](LICENSE). 기여는 [CONTRIBUTING.md](CONTRIBUTING.md)를 먼저 읽어달라 (CLA가 있다).

---

기획은 [docs/product-spec.md](docs/product-spec.md)(v0.4)가 기준이다. `docs/`의 나머지는 **어떻게 만들 것인가**를 다룬다.

## 개발 실행

```bash
pnpm install

# 터미널 1 — 에이전트 호스트 (Node 사이드카)
pnpm host --port 5175 --token dev-token

# 터미널 2 — 웹 UI (개발은 브라우저에서, 출시는 Tauri로)
pnpm dev                      # http://127.0.0.1:5174

# UI만 단독으로 보기 (mock platform, host 불필요)
pnpm dev                      # http://127.0.0.1:5174/?mock=1
```

검증:

```bash
pnpm verify      # lint + 의존 규칙 + 타입 + 단위/통합 테스트 (484개)
pnpm e2e         # Playwright 관제 루프 시나리오 (157개)
pnpm smoke       # 실 Claude 세션으로 host 관통 검증 (소액 과금)
```

현재 상태: **M2 완료 → 도그푸딩 중** — [실행 결과](docs/plans/m2-result.md), 배포 준비는 [점검표](docs/plans/beta-release-checklist.md).

## 문서 지도

| 문서 | 내용 | 먼저 읽어야 할 것 |
|---|---|---|
| [product-spec.md](docs/product-spec.md) | 기획서: 요구사항(FR-1~21), 화면, 로드맵, 리스크 | — |
| [architecture.md](docs/architecture.md) | 전체 아키텍처: 변경 축, 레이어, 의존 규칙, 디자인 패턴, 프로세스 토폴로지 | product-spec §6 |
| [folder-structure.md](docs/folder-structure.md) | 모노레포 패키지 분할과 배치 규칙, 확장 시나리오별 "코드가 갈 곳" | architecture |
| [tech-stack.md](docs/tech-stack.md) | 라이브러리 선정과 근거, 금지 목록 | architecture |
| [platform-abstraction.md](docs/platform-abstraction.md) | **웹 개발 → Tauri 전환의 핵심**: Platform 포트, 구현 매트릭스, 강제 장치 | architecture |
| [protocol.md](docs/protocol.md) | UI ↔ Agent Host 메시지 프로토콜, 스키마, 버전 규칙 | architecture |
| [agent-host.md](docs/agent-host.md) | Node 사이드카 내부 구조, AgentAdapter, 새 도구 추가 절차 | protocol |
| [state-management.md](docs/state-management.md) | 프론트 상태 흐름: 이벤트 → 스토어 → 셀렉터, 영속화·복원 | architecture, protocol |
| [spikes/m0-findings.md](docs/spikes/m0-findings.md) | M0 검증 결과: 권한 오버라이드·이벤트·Codex·토폴로지 전부 성립 | — |
| [plans/m1-plan.md](docs/plans/m1-plan.md) | M1 실행 플랜: 페이즈·태스크·완료 기준·게이트 | 전부 |
| [plans/m1-result.md](docs/plans/m1-result.md) | M1 실행 결과: 게이트 통과 현황, 성능 실측, 구현 중 결정, G5 실측 기록 | m1-plan |
| [plans/m1.5-plan.md](docs/plans/m1.5-plan.md) | M1.5 계획: 상시 가동 + 검증 프로토콜, 이후 마일스톤 개요 | m1-result |
| [plans/m1.5-result.md](docs/plans/m1.5-result.md) | M1.5 실행 결과: 실측이 잡은 결함 5건, 성능, 남은 한계 | m1.5-plan |
| [plans/m2-plan.md](docs/plans/m2-plan.md) | M2 계획 v2 (독립 재검증 반영) | m1.5-result |
| [plans/m2-result.md](docs/plans/m2-result.md) | **M2 실행 결과**: 배포 빌드 통과, 실측 결함 5건, 도그푸딩 시작 방법 | m2-plan |

## 문서 규칙

- 설계를 바꾸면 **코드와 같은 PR에서 해당 문서를 고친다.** 문서와 코드가 다르면 문서가 틀린 것이다.
- 각 문서의 "결정" 표는 근거를 함께 적는다. 근거 없는 결정은 재검토 대상.
- 기획서(product-spec)와 충돌하면 기획서가 이긴다 (기능 요구), 단 구현 방식은 설계 문서가 이긴다.

## 실행

```bash
pnpm app:dev      # ← 평소 개발은 이걸로. UI 저장하면 즉시 반영(HMR)
pnpm app          # 배포 앱 빌드 + 실행 (증분 ~60초)
pnpm app:open     # 이미 빌드된 앱만 열기

# 무엇을 고쳤느냐에 따라 반영 방식이 다르다
#   packages/ui, packages/platform  → app:dev에서 저장 즉시 (HMR)
#   packages/agent-host, protocol    → 앱 재시작 필요 (host는 watch하지 않는다)
#   apps/desktop/src-tauri (Rust)    → 재컴파일 후 자동 재시작
#   PATH·번들·네이티브 관련           → pnpm app (배포 앱에서만 재현되는 것들)
pnpm dev          # 웹만 (host는 pnpm host 별도) — UI 손볼 때만
```
