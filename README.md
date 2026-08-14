# Control Center

> 여러 에이전트 코딩 도구(Claude Code, Codex CLI)를 한 창에서 실행·관찰·제어하는 경량 데스크톱 앱

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
pnpm verify      # lint + 의존 규칙 + 타입 + 단위/통합 테스트 (180개)
pnpm e2e         # Playwright 관제 루프 시나리오 (14개)
pnpm smoke       # 실 Claude 세션으로 host 관통 검증 (소액 과금)
```

현재 상태: **M1 구현 완료** — [실행 결과](docs/plans/m1-result.md), 남은 것은 사람이 직접 써보는 G5.

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
| [plans/m1-result.md](docs/plans/m1-result.md) | M1 실행 결과: 게이트 통과 현황, 성능 실측, 구현 중 결정, **G5 실행 방법** | m1-plan |

## 문서 규칙

- 설계를 바꾸면 **코드와 같은 PR에서 해당 문서를 고친다.** 문서와 코드가 다르면 문서가 틀린 것이다.
- 각 문서의 "결정" 표는 근거를 함께 적는다. 근거 없는 결정은 재검토 대상.
- 기획서(product-spec)와 충돌하면 기획서가 이긴다 (기능 요구), 단 구현 방식은 설계 문서가 이긴다.
