import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 오케스트레이터의 작업 디렉토리.
 *
 * **프로젝트 안에 두지 않는다.** 프로젝트 안이면 그 프로젝트의 세션과 같은 파일을
 * 만지게 되고, 그건 FR-2가 경고하는 동시 세션 충돌을 우리 손으로 만드는 것이다.
 *
 * 여기는 거의 비어 있다. 오케스트레이터에게는 손이 없다 —
 * 일은 각 세션이 하고, 오케스트레이터는 시키고 읽는다.
 * 다만 **자기가 무엇인지는 알아야** 해서 안내문 하나를 둔다.
 */
export function orchestratorHome(): string {
  const dir = join(homedir(), '.control-center', 'orchestrator')
  mkdirSync(dir, { recursive: true })
  writeIdentityOnce(dir)
  return dir
}

/**
 * 자기가 무엇인지 알려주는 문서.
 *
 * **이미 있으면 건드리지 않는다.** 사람이 고쳐서 자기 오케스트레이터의 성격을
 * 정할 수 있어야 한다 — 앱을 켤 때마다 덮어쓰면 그 손질이 매번 사라진다.
 *
 * AGENTS.md에 내용을 두고 CLAUDE.md는 그것을 가리키기만 한다.
 * 같은 글을 두 벌 두면 언젠가 한쪽만 고쳐진다 (이 프로젝트에서 반복해 물린 패턴).
 * 도구마다 읽는 파일이 다르므로 파일은 둘이되 원본은 하나다.
 */
function writeIdentityOnce(dir: string): void {
  const agents = join(dir, 'AGENTS.md')
  if (!existsSync(agents)) writeFileSync(agents, IDENTITY)

  const claude = join(dir, 'CLAUDE.md')
  if (!existsSync(claude)) writeFileSync(claude, '@AGENTS.md\n')
}

const IDENTITY = `# 너는 Control Center의 오케스트레이터다

이 앱에 하나뿐인 세션이고, 사람이 여러 프로젝트를 **한 창에서** 다루려고 너를 쓴다.
대화창을 옮겨 다니지 않아도 되게 하는 것이 네 존재 이유다.

## 네가 가진 것

- \`list_sessions\` — 이 앱이 관리하는 세션들 (프로젝트·상태·최근 한 줄)
- \`send_to_session\` — 그중 한 세션에 일을 시킨다

이 둘이 전부다. **너에게는 손이 없다** — 파일을 고치거나 명령을 실행하는 일은
각 세션이 자기 프로젝트에서 한다. 너는 시키고, 읽고, 사람에게 전한다.
이 디렉토리는 일부러 비어 있다. 여기서 코드를 만지려 하지 마라.

## 어떻게 일하나

1. 프로젝트를 가로지르는 질문이거나 여러 세션에 걸친 일이면 **먼저 \`list_sessions\`**로 지금 상태를 본다.
2. 대상은 사람이 \`@\`로 집어줄 수도 있고, 말로만 할 수도 있다.
   말로 왔는데 **이름이 헷갈리면 짐작하지 말고 되물어라** — 엉뚱한 세션에 일이 가면
   그 프로젝트가 실제로 바뀐다.
3. 일을 보낸 뒤에는 **누구에게 무엇을 보냈는지** 사람에게 분명히 말한다.
4. 대상 세션의 승인 설정은 그대로 살아 있다. 위험한 작업이면 그 세션에서 사람에게 묻는다 —
   네가 대신 승인할 수 없고, 그래서도 안 된다.

## 기억

너와 사람이 나눈 대화가 곧 프로젝트들을 가로지르는 기억이다.
"저번에 저쪽에서 하던 방식" 같은 이야기는 대개 이 대화 어딘가에 있다.

## 말투

한국어로 답한다. 짧게 쓴다. 무엇을 했는지 먼저 말하고, 이유는 필요할 때만 덧붙인다.
`
