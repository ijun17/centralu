# M0 스파이크 결과 (2026-08-15)

> 결론: **설계 전제 전부 성립. 아키텍처 수정 불필요, M1 진행 가능.**
> 검증 코드: `spike/` (일회용 — M1 구현 시작 후 삭제 예정)

검증 환경: Claude Code 2.1.223 / Agent SDK 0.3.231 / Codex CLI 0.147.0 / Node 26.
양쪽 CLI 모두 전역 자동승인 상태에서 검증 (Claude: `defaultMode: bypassPermissions`, Codex: `approval_policy = "never"` + `danger-full-access`) — 기획서 §2가 우려한 최악 조건 그대로.

## A. 권한 오버라이드 — ✅ 양쪽 모두 성립

| | Claude (Agent SDK) | Codex (app-server) |
|---|---|---|
| 세션 단위 오버라이드 | `options.permissionMode: 'default'` + `canUseTool` 콜백 | `thread/start` params `approvalPolicy: 'untrusted'` |
| 전역 bypass 이김? | **예** — Write·Bash(curl) 승인 요청이 콜백으로 도착 | **예** — `item/commandExecution/requestApproval` 서버 요청 도착 |
| 승인 → 실행 완주 | allow 응답 후 실행됨 | `decision: 'accept'` 응답 후 실행, 파일 생성 확인 |

**주의 (어댑터 구현 시 필수):**
- Claude: `allowedTools`에 bare 도구명(`['Bash']`)을 넣으면 canUseTool이 **셰도잉**되어 콜백이 안 옴 (SDK 경고 `CAN_USE_TOOL_SHADOWED` 확인). 어댑터는 allowedTools를 쓰지 않는다.
- Claude: 안전한 명령(`echo` 등)은 샌드박스 자동 승인이라 승인 요청 자체가 없음 — 앱 관점에선 장점 (불필요한 승인 소음 감소). "승인 요청이 안 온다 = 버그"가 아님.
- Claude: SDK 세션에도 사용자 훅·플러그인이 로드됨 (hook_started 관찰, OMC 훅·osascript 알림 실행됨). Centralu 세션에서 사용자 훅 처리 방침 필요 → M1 설계 항목 (억제 옵션 또는 그대로 두기).
- Codex: 승인 응답 decision은 `accept | acceptForSession | acceptWithExecpolicyAmendment | applyNetworkPolicyAmendment | decline | cancel`. `acceptForSession` = FR-3 "항상 허용(세션)"과 정확히 대응.

## B. 이벤트 수집 — ✅ 필요한 것 전부 나옴

| 필요 정보 (FR) | Claude | Codex |
|---|---|---|
| 스트리밍 델타 (FR-3) | `includePartialMessages: true` → `stream_event` | `item/agentMessage/delta` |
| 도구 호출 (FR-3) | assistant 메시지 `tool_use` 블록 | `item/started`·`completed` (type: commandExecution 등, command·cwd 포함) |
| 턴 완료 (FR-12) | `result` 메시지 | `turn/completed` |
| usage/비용 (FR-9) | `result.usage`, `modelUsage` (모델별 tokens+`costUSD`) | `thread/tokenUsage/updated` (턴별 누적) |
| 컨텍스트 (FR-14) | `modelUsage.contextWindow` (200k) + 턴별 input tokens | tokenUsage total + config의 context window |
| **한도 (FR-9 limited)** | `rate_limit_event`: status·**resetsAt**·rateLimitType(five_hour) | `account/rateLimits/updated`: **usedPercent 21%·windowDurationMins 10080(주간!)·resetsAt** |
| 세션 제목 (FR-18) | `listSessions()`/`getSessionInfo()` — summary 필드 (자동 생성) | `thread/name/updated` 알림 + `thread/name/set` |
| resume (FR-10) | `options.resume: sessionId` — 이전 대화 기억 확인됨 | `thread/resume` 메서드 존재 (미실행, 스키마 확인) |
| 컴팩션 마커 (FR-14) | — (미확인) | `thread/compacted` 알림 |

**보너스 발견:**
- Claude `listSessions()`가 **머신 전체** 세션 목록(제목·최종수정·firstPrompt)을 반환 — 외부 실행 세션 표시(FR-9의 "머신 전체" 철학)에 활용 가능.
- Codex에 `account/usage/read`, `AccountTokenUsageDailyBucket` 존재 — **Codex 쪽은 주간 사용량도 API로 조회 가능성** 있음. FR-9 로그 파싱 전에 이 경로 우선 검토.
- Codex `turn/diff/updated` — 턴 단위 diff를 프로토콜이 직접 줌 (FR-4 실시간 갱신에 활용).
- Codex `thread/fork`, `turn/steer`, `review/start` 등 풍부한 부가 기능.

## C. Codex 프로토콜 안정성 (C4 리스크) — 예상보다 양호

- `codex app-server generate-ts` / `generate-json-schema` — **공식 타입 생성기 내장**. 어댑터 빌드 시 버전별 바인딩을 생성·커밋해 diff로 프로토콜 변동을 즉시 감지 가능.
- 전송: stdio, newline-delimited JSON, `jsonrpc` 필드 없는 경량 JSON-RPC (`{id, method, params}` / `{id, result}`).
- 핸드셰이크: `initialize` → `initialized` 알림. 여전히 "[experimental]" 표기 — 스냅샷 테스트(기존 계획) 유지.

## D. 토폴로지 (dev 웹 개발) — ✅ E2E 성공

브라우저 → localhost WS(토큰 인증) → 미니 host → Agent SDK → 스트리밍 델타 → 화면 렌더까지 완주 ("BROWSER_E2E_OK", $0.016). Playwright로 자동 검증 — E2E 테스트 전략도 함께 입증됨.

## E. 파일 체크포인트 (FR-2 복구 경로) — 가능성 확인

`~/.claude/file-history/<sessionId>/<hash>@v<N>` 에 세션별 파일 버전 사본이 남는 것 확인. 단 **비공식 포맷** — 1차 복구 경로는 계획대로 어댑터의 tool_call 이벤트에서 변경 전 내용 캡처, file-history는 보조로 재검토 (M2).

## 설계에 반영할 사항 (문서 수정 없이 구현 시 참고)

1. ClaudeAdapter: allowedTools 사용 금지, includePartialMessages 사용, 사용자 훅 로드 방침 결정 필요.
2. CodexAdapter: 승인 decision 6종 매핑 (`acceptForSession` → "항상 허용·세션"), 바인딩 생성기를 CI에 편입.
3. FR-9: Codex는 `account/usage/read` 우선 검토 → 안 되면 로그 파싱 (Claude는 로그 파싱 확정).
4. protocol의 `limit_reached` 이벤트에 `usedPercent`·`windowMins` 필드 추가 여지 (Codex가 주므로).
