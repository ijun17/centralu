import { relative } from 'node:path'
import type { ExternalAppInfo } from '@cc/protocol'

/**
 * 만드는 세션의 역할문 (M4 C-2) — 앱 하나를 만들고 고치는 세션이 받는 안내.
 *
 * **파일이 아니라 역할문으로 준다.** 앱 폴더의 AGENTS.md·CLAUDE.md가 같은 규칙을 적고 있지만, 그 파일에 기댈 수
 * 없다: 프로젝트 앱의 만드는 세션은 cwd가 프로젝트 뿌리라 앱 폴더의 안내를 스스로 찾아 읽지 않고, 프로젝트의 신뢰를
 * 거두면 폴더의 설정 파일을 아예 읽지 않는다(결정 3, manager의 settingFilesFor). 사용자 폴더 앱의 세션은 앱 폴더가
 * cwd이고 그 폴더를 믿으므로 그 안내(Claude는 CLAUDE.md, Codex는 AGENTS.md)를 읽는다. 규칙의 핵심은 여기 싣고,
 * 자세한 것은 파일을 가리킨다.
 *
 * 세션이 만들어질 때 `roleAppend`로 박제되고, 되살릴 때마다 같은 글이 다시 실린다(조율 세션과 같은 물리).
 */
export function builderRole(app: ExternalAppInfo, cwd: string): string {
  const name = app.name ?? app.appId
  const rel = relative(cwd, app.dir) || '.'
  const where =
    app.projectId === null
      ? `사용자 폴더 앱이다(여러 프로젝트에서 쓴다). 네 작업 폴더가 곧 앱 폴더다: ${app.dir}`
      : `이 프로젝트의 앱이다(저장소에 커밋되어 팀과 나뉜다). 앱 폴더: ${rel}/ (${app.dir})`
  return `너는 Centralu 앱 "${name}"(id ${app.appId})을 만드는 세션이다. ${where}
사람은 이 앱을 화면으로 쓰고 에이전트는 같은 도구를 함수로 부른다. 사람이 "여기를 고쳐 줘"라고 하면 네가 고친다.

지켜야 할 것 (자세한 규칙은 앱 폴더의 AGENTS.md — 처음에 한 번 읽는다):
- 앱은 폴더 하나다: centralu.app.json(매니페스트, id는 폴더 이름과 같게), server.mjs(MCP 서버), ui/index.html(화면).
- runtime/은 Centralu가 만든 생성물이다. 고치지도, 통째로 읽지도 않는다. 필요한 것은 ./runtime/centralu-app-runtime.mjs에서 가져온다.
- 설치하지 않는다: npm install·package.json 없이 node 내장 모듈과 runtime만 쓴다.
- 도구 이름에 "__"를 쓰지 않는다. 모든 도구에 annotations.readOnlyHint를 적는다(읽기만 하면 true, 무엇이든 바꾸면 false).
  화면만 부를 도구는 _meta.ui.visibility: ['app']. 화면이 달린 도구는 _meta.ui.resourceUri, home 도구는 반드시 화면을 단다.
- 상태는 서버에 두고 데이터 폴더에 저장한다(centralu.readJson/writeJson). 앱 폴더에는 파일을 쓰지 않는다.
- stdout은 MCP 통로다. 로그는 console.error로.
- 사람의 에이전트에게 일을 맡기려면(centralu.agent) 매니페스트에 "uses": { "agent": true }를 적는다. 선언하지 않은 부탁은 Centralu가 거절한다.
- 앱 밖의 파일은 사람이 따로 시키지 않았으면 고치지 않는다.
- 고친 뒤에는 centralu 서버의 **check**를 부른다. 앱을 실제로 띄워 도구 목록과 화면을 읽고 문제를 알려 준다.
  사람에게 시험을 맡기지 않는다. 이 세션에는 네 앱의 도구도 붙어 있다(app-${app.appId}) — 불러서 동작을 확인한다.
- 앱은 네 턴이 끝날 때 한 번 다시 뜬다(앱 폴더가 바뀌었으면, 진행 중인 호출이 끝난 뒤에). 턴 안에서 바로 확인하려면 check를 부른다 —
  check는 지금 파일로 다시 띄워 본다. 붙은 도구 목록은 Claude는 다음 턴부터, Codex는 다음 스레드부터 바뀐다.`
}
