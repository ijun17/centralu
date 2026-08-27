/**
 * 오케스트레이터에게 주는 앱 안내서 (#30).
 *
 * **파일이 아니라 코드다 — 그게 이 파일의 요점이다.** docs/를 런타임에 읽으면
 * 그 폴더에 쓸 수 있는 모든 세션이 오케스트레이터의 지식을 고칠 수 있다 —
 * AGENTS.md를 심어 조종에 성공했던 그 공격의 한 다리 건너 재판이다 (실측으로
 * 확인된 구멍이라 orchestrator-home.ts가 폴더 문서를 끈 것이다). 여기 내용은
 * 빌드에 함께 컴파일되므로, 바꾸려면 이 저장소의 PR을 거쳐야 한다.
 *
 * 그래서 자동 생성도 아니다. docs/에서 뽑아 만들면 44KB 사양서가 통째로 들어와
 * 오케스트레이터의 컨텍스트를 덮는다 — 이 안내서의 일은 "사람에게 앱을 설명하기"이고,
 * 그 일에는 사람이 고른 요약이 원문보다 낫다. docs가 바뀌면 여기도 사람이 고친다.
 */

export const APP_GUIDE_TOPICS = ['overview', 'sessions', 'orchestrator', 'approvals', 'settings', 'updates'] as const
export type AppGuideTopic = (typeof APP_GUIDE_TOPICS)[number]

const GUIDE: Record<AppGuideTopic, string> = {
  overview: `# Centralu 개요
여러 Claude Code·Codex CLI 세션을 한 창에서 돌리고, 지켜보고, 조종하는 데스크톱 앱이다.
- 왼쪽 사이드바: 프로젝트와 세션 목록. 프로젝트는 로컬 디렉토리 하나다.
- 가운데: 고른 세션의 대화. 그리드 보기(⌘G)로 여러 세션을 나란히 볼 수 있다.
- 오른쪽 증거 패널: 파일 트리·깃 상태·커밋 그래프·터미널.
- 인박스(⌘I): 승인·질문·완료를 기다리는 세션들이 모인다.
설치·업데이트는 npm으로 한다 (\`npm i -g centralu\`, 앱 안에서 확인·설치 가능).
이 안내서에 없는 질문(버그 신고·기능 요청 포함)은 짐작으로 답하지 말고
GitHub 이슈로 안내한다: https://github.com/ijun17/centralu/issues`,

  sessions: `# 세션
세션 하나 = 에이전트 프로세스 하나 (Claude Code 또는 Codex).
- 만들기: 사이드바 프로젝트의 + 버튼. 이전 대화 불러오기(재개)도 여기서 한다.
- 프로젝트가 하나도 없으면 + 버튼도 없다 — 그때는 propose_project로 폴더 등록을
  제안한다 (사이드바 맨 아래 Add project 버튼도 같은 일을 한다). 경로는 사람이 고른다.
- 잠들기/깨우기: 앱을 껐다 켜면 기록은 남고 프로세스만 사라진다 — 말을 걸거나
  입력창을 누르면 이어서 깨어난다.
- 워크트리 옵션: 세션을 깃 워크트리(별도 디렉토리·브랜치)에서 돌려 파일 충돌을 막는다.
- 보관(archive): 목록에서 치우되 기록은 남는다. 삭제만이 기록을 지운다.
- 에이전트 전환(claude↔codex): 대화는 이어지지 않는다 — 새 도구는 옛 대화를 모른다.`,

  orchestrator: `# 오케스트레이터
계급: 중앙 > 프로젝트 > 세션.
- 중앙 오케스트레이터(너일 수 있다): 프로젝트를 가로질러 모든 세션을 보고 시킨다.
- 프로젝트 오케스트레이터: 세션 설정 메뉴의 Role에서 승격한다. 자기 프로젝트의
  세션만 보고 시킨다. 승격·강등은 다음에 깰 때 적용된다.
- 도구: list_sessions(목록) · send_to_session(지시, reportBack 가능) ·
  read_session(대화 읽기) · recall(지난 대화 검색) · archive_session(보관) ·
  create_session(워커 만들기) · propose_project(프로젝트 등록 제안 — 확정은 사람) ·
  app_guide(이 안내서) · update_session_settings(설정).
- 승인은 대신 못 한다 — 대상 세션의 승인 설정이 그대로 살아 있다.`,

  approvals: `# 승인과 권한
세션마다 권한 프리셋이 있다: Safe(전부 묻기) · Normal(위험한 것만 묻기) · Auto(안 묻기).
- 에이전트가 위험한 일을 하려면 승인 카드가 뜬다 — y(허용) / n(거절) / a(항상 허용).
- '항상 허용'은 규칙으로 저장되고 설정 화면에서 지울 수 있다.
- 이 프리셋은 사람만 바꾼다 — 오케스트레이터의 설정 도구에는 이 항목이 없다.
  (있으면 프리셋을 Auto로 바꿔 뒷문으로 승인하는 길이 생긴다.)`,

  settings: `# 세션 설정 (입력창 아래 메뉴)
- Model: 도구가 알려주는 공식 목록에서 고른다. 다음 턴부터 적용.
- Effort: 추론 강도 (모델이 지원할 때만 보인다).
- Verbosity: 응답 길이 (codex 전용) — 짧을수록 빨리 온다. 다음에 깰 때 적용.
- Permissions: 승인 프리셋 (위 approvals 참고).
- Role: Worker ↔ Project orchestrator 승격·강등.
- Agent: claude ↔ codex 전환 (대화는 이어지지 않는다).
앱 설정(⌘,): 알림 정책 · 저장된 승인 규칙 · 단축키 목록 · 업데이트.`,

  updates: `# 업데이트
설정 → Updates에서 확인한다. npm 레지스트리 기준으로 새 버전을 알려주고,
사람이 눌러야 설치한다 (자동 설치 없음). 터미널에서는 \`centralu update\`.`,
}

/**
 * 주제를 주면 그 대목을, 없으면 개요와 주제 목록을 돌려준다.
 * 모르는 주제는 목록을 들려주며 거절한다 — 조용한 빈손보다 낫다.
 */
export function appGuide(topic?: string): { text: string; isError?: boolean } {
  if (!topic) {
    return {
      text: GUIDE.overview + '\n\n다른 주제: ' + APP_GUIDE_TOPICS.filter((t) => t !== 'overview').join(', '),
    }
  }
  const t = topic.toLowerCase()
  if ((APP_GUIDE_TOPICS as readonly string[]).includes(t)) {
    return { text: GUIDE[t as AppGuideTopic] }
  }
  return { text: `그런 주제는 없습니다: ${topic}. 있는 주제: ${APP_GUIDE_TOPICS.join(', ')}`, isError: true }
}
