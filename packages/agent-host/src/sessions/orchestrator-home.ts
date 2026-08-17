import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 오케스트레이터의 작업 디렉토리.
 *
 * **프로젝트 안에 두지 않는다.** 프로젝트 안이면 그 프로젝트의 세션과 같은 파일을
 * 만지게 되고, 그건 FR-2가 경고하는 동시 세션 충돌을 우리 손으로 만드는 것이다.
 *
 * 여기는 비어 있는 자리다. 오케스트레이터에게는 손이 없다 —
 * 일은 각 세션이 하고, 오케스트레이터는 시키고 읽는다.
 */
export function orchestratorHome(): string {
  const dir = join(homedir(), '.control-center', 'orchestrator')
  mkdirSync(dir, { recursive: true })
  return dir
}
