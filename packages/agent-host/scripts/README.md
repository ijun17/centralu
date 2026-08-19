# 스크립트 — 자동 테스트가 못 보는 것을 본다

여기 있는 것은 **실물을 상대로 하는 검증**이다. 단위 테스트는 우리가 만든 가짜를 상대하지만,
이 프로젝트에서 나온 결함의 상당수는 진짜 CLI·진짜 PTY·진짜 배포 앱에서만 드러났다.

`claude`·`codex`를 실제로 호출하는 것들은 **소액이 과금된다.** 그래서 CI에 걸지 않고,
관련된 곳을 고쳤을 때 손으로 돌린다.

## 빌드에 걸려 있는 것 (자동)

| 스크립트 | 언제 도나 |
|---|---|
| `fix-pty-permissions.mjs` | `postinstall` — node-pty의 spawn-helper에 실행 권한을 세운다 |
| `bundle.mjs` | `pnpm bundle:host` — 배포용 host 번들 (esbuild, target node22) |
| `codex-bindings.mjs` | `pnpm codex:bindings` — codex 프로토콜 타입 생성·의존 계약 갱신 |

## npm 스크립트로 걸린 검증

```bash
pnpm smoke               # 실 Claude 세션으로 host 관통
pnpm smoke:resume        # 재개(resume)가 실제로 이어지는가
pnpm smoke:codex         # Codex 어댑터 관통
pnpm smoke:orchestrator  # 오케스트레이터 + MCP 도구
pnpm smoke:schemas       # 프로토콜 스키마가 실물과 맞는가
pnpm smoke:question      # AskUserQuestion 왕복
pnpm smoke:perm          # 권한 프리셋이 세션에 실리는가
pnpm smoke:usage         # 사용량이 두 도구에서 같은 모양인가
pnpm smoke:context       # 컨텍스트 게이지가 말이 되는 값인가
pnpm smoke:models        # 두 도구가 모델 목록을 주는가
pnpm smoke:terminal      # 진짜 PTY로 터미널 관통
pnpm smoke:orphan        # 도구 쪽에서 세션이 사라졌을 때의 처신
pnpm perf:idle           # 유휴 성능 (host 프로세스만, §7.1 목표 대비)
```

## 프로브 — 결정의 근거로 남은 것

한 번 쓰고 버리는 스크립트가 아니라, **코드 주석이 근거로 가리키는 기록**이다.
"왜 이렇게 짰나"를 되물을 때 다시 돌려보라고 남겨 둔다.

| 스크립트 | 무엇을 재서 무엇을 정했나 |
|---|---|
| `probe-askuserquestion.mts` | AskUserQuestion을 실제로 어떻게 받아 답하는가 → `adapters/claude/index.ts`가 이 결과를 따른다 |
| `probe-permission-mode.mts` | 권한 모드가 전역 설정을 세션 단위로 덮어쓸 수 있는가 (M0의 최우선 전제) |
