/**
 * The app guide given to the orchestrator (#30).
 *
 * **It is code, not a file — that is the whole point of this file.** If docs/ were read at
 * runtime, every session with write access to that folder could edit the orchestrator's
 * knowledge — one step removed from the attack that succeeded before by planting an AGENTS.md
 * (a hole confirmed by measurement, which is why orchestrator-home.ts turned off reading folder
 * documents). The content here is compiled into the build, so changing it must go through a pull
 * request in this repository.
 *
 * That is also why it is not auto-extracted from docs/. Extracting it would pull in the whole
 * 44KB specification and bury the orchestrator's context — this guide's job is "explain the app
 * to the person," and for that job a summary a person chose is better than the raw source. When
 * docs change, a person updates this file too.
 *
 * **The one exception: the tool list is not written by hand** (M4 P-4). The hand-written list was
 * wrong twice: it kept advertising `archive_session` even after the archive feature was removed
 * (58d2335), and it knew nothing at all about the control-rail app's tools (#81). Which seat can
 * call which tool is already decided by the tool registry (orchestrator-tools.ts), so that
 * decision is taken as-is and rendered here (`GuideSeats`). The registry is also compiled code,
 * so the reason above (nothing is read from a file at runtime) still holds. Tool names left in
 * the hand-written text are checked against the registry by app-guide.test.ts.
 */

export const APP_GUIDE_TOPICS = ['overview', 'sessions', 'orchestrator', 'apps', 'approvals', 'settings', 'updates'] as const
export type AppGuideTopic = (typeof APP_GUIDE_TOPICS)[number]

/** One tool entry from the registry — the name and description (the same description given to the model) */
export type GuideTool = { name: string; description: string }

/**
 * The tools each of the three directing seats can call **right now**.
 *
 * The caller (orchestrator-tools.ts) fills this in from the registry's decisions
 * (profileAllows, appToolEntries). Why this file does not import the registry: the registry
 * imports this file's topic list to draw the app_guide schema — wiring the import the other way
 * too would create a cycle.
 */
export type GuideSeats = { orchestrator: GuideTool[]; manager: GuideTool[]; scoped: GuideTool[] }

const STATIC: Record<Exclude<AppGuideTopic, 'orchestrator'>, string> = {
  overview: `# Centralu 개요
여러 Claude Code·Codex CLI 세션을 한 창에서 돌리고, 지켜보고, 조종하는 데스크톱 앱이다.
(단축키의 ⌘는 macOS 기준이다. 다른 OS에서는 Ctrl이다.)
- 왼쪽 사이드바: 맨 위에 Orchestrator·Grid 버튼, 그 아래 프로젝트와 세션 목록, 맨 아래 Add project.
  프로젝트는 로컬 디렉토리 하나다.
- 가운데: 고른 세션의 대화. 사이드바의 Grid 버튼을 누르면 여러 세션을 나란히 본다
  (세션을 그 버튼에 끌어다 놓아도 그리드에 들어간다).
- 오른쪽 증거 패널: 세션 하나를 볼 때만 선다. Git · History(커밋 그래프) · Files · Terminal 탭이 있고,
  ⌘⇧1~4로 탭을 고르고 ⌘B로 접는다.
- Waiting(⌘I): 사람을 기다리는 세션이 모인다 — 승인 대기, 오류, 응답 대기(턴이 끝나 다음 말을 기다림).
  ⌘⇧A는 다음 기다리는 세션으로 간다.
- 커맨드 팔레트는 ⌘K. 설정은 위쪽 막대의 Settings 버튼이나 팔레트의 Open settings로 연다.
설치·업데이트는 npm으로 한다 (\`npm i -g centralu\`, 앱 안에서 확인·설치 가능).
이 안내서에 없는 질문(버그 신고·기능 요청 포함)은 짐작으로 답하지 말고
GitHub 이슈로 안내한다: https://github.com/ijun17/centralu/issues`,

  sessions: `# 세션
세션 하나 = 에이전트 프로세스 하나 (Claude Code 또는 Codex).
- 만들기: 사이드바의 프로젝트 줄에 마우스를 올리면 나오는 ⋯ 메뉴 → New session.
  뜨는 창에서 새 대화를 시작하거나, 그 폴더에서 그 도구로 했던 지난 대화를 골라 불러온다(Load).
- 프로젝트를 만드는 곳은 **사이드바 맨 아래의 Add project 버튼**이다 (누르면 폴더 선택창이 열린다).
  오케스트레이터 대화가 비어 있을 때 보이는 폴더 고르기 링크도 같은 창을 연다.
  프로젝트가 0개면 New session을 열 자리가 없으므로, "프로젝트 어떻게 만들어?"에는
  Add project를 알려주고 propose_project로 자리를 짚어 준다.
- 잠들기/깨우기: 앱을 껐다 켜면 기록은 남고 프로세스만 사라진다 — 세션을 고르거나
  입력창을 누르거나 말을 걸면 이어서 깨어난다.
- 워크트리 옵션 (git 저장소일 때만): New session 창의 "Run in a git worktree"를 켜면
  별도 디렉토리·브랜치에서 돌아 파일 충돌을 막는다.
- 인수인계: 세션의 ⋯ → Hand off to a fresh session… — 지금 세션이 노트를 쓰고, 새 세션이
  그 노트로 시작한다. 받는 쪽 도구를 고를 수 있다. 워크트리 세션은 아직 넘길 수 없다.
- 삭제: 세션의 ⋯ → Delete session…. 기본으로 도구 쪽 대화 파일까지 지운다. 그 칸을 끄면
  대화가 도구에 남아 New session 창의 지난 대화 목록에서 다시 불러올 수 있다.
- 보관(아카이브) 기능은 없다 — 폐기됐다. 목록에서 치우는 방법은 삭제뿐이다.
- 세션의 에이전트(claude↔codex)를 바꾸는 메뉴는 없다. 새 도구는 옛 대화를 모르므로,
  다른 도구로 이어가려면 인수인계를 쓴다. 오케스트레이터만 예외다(설정 → Orchestrator).`,

  apps: `# 앱
실험 기능은 앱으로 들어온다. 설정 → Apps에서 앱마다 켜고 끈다 — 끄면 화면과 도구가 물러나고
데이터는 남는다. 지금 있는 앱은 관제 레일(Control rail) 하나이고, 기본으로 켜져 있다.

## 관제 레일
오케스트레이터 화면의 오른쪽 레일이다 (폭은 왼쪽 모서리를 끌어 바꾼다). 네 칸이다.
- Notices: 사람을 지목해 부른 알림. 에이전트가 control_notify로 올리고, 감시(아래)가 걸리거나
  업무가 끝나도 선다. 사람이 × 로 지운다 — 에이전트는 올릴 수만 있다.
- My turn: 사람을 기다리는 세션들. 승인·거절, 한 줄 답(Reply…)을 레일 안에서 끝낼 수 있다.
- Tasks: 업무. + New task로 이름·목표·구성원 세션을 정하면 그 업무만 보는 반장(조율 세션)이 선다.
  반장은 구성원에게 일을 나누고, 업무 보드에 상태를 적고, 사람이 필요하면 레일로 부른다.
  오케스트레이터도 control_create_task로 업무를 만들 수 있다. 끝난 업무는 Done 아래로 간다.
- Running: 지금 일하는 세션들과 그 세션이 마지막으로 한 말.
설정 → Apps → Control rail의 패널: 레일 사용 횟수, 반장을 띄울 도구·모델·추론 강도(기본 Claude, high),
그리고 감시(Watches). 감시는 도구 호출 한 줄에 대한 글자 일치이고, 걸리면 레일에 급한 알림이 선다.
에이전트를 멈추지는 않는다.
관제 앱이 꺼져 있으면 반장 세션은 사이드바의 No app 목록에 선다 — 앱을 꺼도 세션에는 닿는다.`,

  approvals: `# 승인과 권한
세션마다 권한 프리셋이 있다: Safe(전부 묻기) · Normal(위험할 때 묻기) · Auto(묻지 않기).
- Normal은 도구 자체의 설정을 따른다. Auto는 Claude에서 권한 확인을 건너뛰고,
  Codex에서는 묻지 않되 작업 폴더 샌드박스 안에서 돈다.
- 에이전트가 위험한 일을 하려면 승인 카드가 뜬다 — y(허용) / n(거절) / a(이 세션에서 항상 허용),
  ⌥a(이 프로젝트에서 항상 허용).
- '항상 허용'은 규칙으로 저장되고 설정 → Permissions에서 지울 수 있다.
- 이 프리셋은 사람만 바꾼다 — 오케스트레이터의 설정 도구(update_session_settings)에는 이 항목이 없다.
  (있으면 프리셋을 Auto로 바꿔 뒷문으로 승인하는 길이 생긴다.)`,

  settings: `# 세션 설정 (입력창 아래 메뉴)
- Model: 도구가 알려주는 공식 목록에서 고른다.
- Effort: 추론 강도 (모델이 지원할 때만 보인다).
- Verbosity: 응답 길이 (codex 전용) — 짧을수록 빨리 온다.
- Speed: 응답 속도 (모델이 속도 등급을 줄 때만 보인다) — 빠를수록 사용량을 더 쓴다.
- Permissions: 승인 프리셋 (위 approvals 참고).
살아 있는 세션의 설정을 바꾸면 대화를 이어서 다시 띄운다 — 다음 턴부터 적용된다.
앱 설정(위쪽 막대의 Settings): Orchestrator(오케스트레이터의 도구 바꾸기·승인된 스킬) · Apps ·
Notifications · Appearance · Permissions(저장된 승인 규칙) · Shortcuts(단축키 목록) · Updates.`,

  updates: `# 업데이트
설정 → Updates에서 확인한다. npm 레지스트리 기준으로 새 버전을 알려주고,
사람이 눌러야 설치한다 (자동 설치 없음). 새 버전 확인은 켤 때와 여섯 시간마다 돌고, 끌 수 있다.
터미널에서는 \`centralu update\`.`,
}

/**
 * The first clause of a tool's description — that much is enough for one guide line.
 *
 * The full description is a usage note for the model, so it is long (when to use it, when not
 * to). Telling a person "what can this seat do" only needs the first sentence. Issue numbers and
 * emphasis markers (warnings meant for the model) carry no meaning in this one line, so they are
 * stripped.
 */
function gist(description: string): string {
  const first = description.split(/ — |\. /)[0] ?? description
  return first
    .replace(/\s*\(#\d+\)/g, '')
    .replace(/\*\*/g, '')
    .replace(/[.:]\s*$/, '')
    .trim()
}

function toolLines(tools: readonly GuideTool[]): string {
  return tools.length === 0 ? '- (없음)' : tools.map((t) => `- ${t.name}: ${gist(t.description)}`).join('\n')
}

function orchestratorTopic(seats: GuideSeats): string {
  return `# 오케스트레이터와 지휘하는 자리
세션을 지휘하는 자리는 셋이다.
- 오케스트레이터(너일 수 있다): 앱에 하나뿐이고, 프로젝트를 가로질러 모든 세션을 보고 시킨다.
- 워크트리 매니저: 프로젝트마다 하나. 워크트리 세션을 처음 만들면 저절로 생기고, 프로젝트의
  ⋯ 메뉴 → Start worktree manager로 먼저 세울 수도 있다. 자기 워크트리 자식만 보고 시킨다.
- 반장(조율 세션): 관제 앱의 업무가 만든다 (apps 주제). 배정된 구성원 세션만 보고 시키고,
  세션을 만들거나 지울 수 없다.
승인은 대신 못 한다 — 대상 세션의 승인 설정이 그대로 살아 있다.

아래 목록은 앱의 도구 명부에서 바로 만든 것이다. 꺼진 앱의 도구는 빠진다.

## 오케스트레이터가 부르는 도구
${toolLines(seats.orchestrator)}

## 워크트리 매니저가 부르는 도구
${toolLines(seats.manager)}

## 반장이 부르는 도구
${toolLines(seats.scoped)}`
}

/**
 * Given a topic, returns that section; given none, returns the overview and the topic list.
 * An unknown topic is rejected along with the list — better than a quiet, empty answer.
 */
export function appGuide(topic: string | undefined, seats: GuideSeats): { text: string; isError?: boolean } {
  if (!topic) {
    return {
      text: STATIC.overview + '\n\n다른 주제: ' + APP_GUIDE_TOPICS.filter((t) => t !== 'overview').join(', '),
    }
  }
  const t = topic.toLowerCase()
  if (t === 'orchestrator') return { text: orchestratorTopic(seats) }
  if ((APP_GUIDE_TOPICS as readonly string[]).includes(t)) {
    return { text: STATIC[t as Exclude<AppGuideTopic, 'orchestrator'>] }
  }
  return { text: `그런 주제는 없습니다: ${topic}. 있는 주제: ${APP_GUIDE_TOPICS.join(', ')}`, isError: true }
}
