import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isProjectId, isSessionId } from '@cc/protocol'
import { dataRoot } from '../data-dir.js'

/**
 * 인수인계 노트의 자리 (#142) — **데이터 폴더 아래** `<데이터>/handoff/<프로젝트 id>/<세션 id>.md`.
 *
 * 예전 자리는 `<프로젝트>/.centralu/handoff/`, 곧 사용자의 저장소였다. 거기서 둘이 틀렸다. 노트는 git에서
 * 무시되지 않았다 — 그 폴더를 거는 규칙은 **이 저장소의** .gitignore에만 있었고, 우리는 사용자의 .gitignore와
 * `.git/info/exclude`를 건드리지 않는다. 그리고 청소가 그 폴더를 믿었다: 저장소에 `.centralu/handoff -> ..`를
 * 커밋해 두면 clone한 사람의 host가 뜰 때 링크를 따라가 저장소 루트의 README.md를 지웠다(실측). 우리가 쓰고
 * 지우는 폴더는 우리 것이어야 한다.
 *
 * **옛 자리는 읽지도 쓰지도 치우지도 않는다.** 이미 놓인 옛 노트는 사용자 저장소의 파일이라 옮기지도 지우지도
 * 않는다 — 옛 후임 세션의 첫 메시지가 아직 그 경로를 가리키고, 그 파일은 그대로 있다.
 *
 * **프로젝트마다 폴더를 나누는 이유**: 후임 Claude 세션은 노트가 든 폴더를 추가 작업 폴더로 받아야 묻지 않고
 * 읽는다(`CreateSessionOpts.readableDirs` — 실측은 거기 적었다). 폴더를 나누면 그 허락이 같은 프로젝트의
 * 노트에서 멈춘다. 한 폴더에 모으면 모든 프로젝트의 노트가 함께 열린다.
 */
// **함수다.** 모듈 로드 시점에 정하면 host가 데이터 폴더를 고정하기 전의 값이 박힌다 (attachments.ts와 같다)
const root = () => join(dataRoot(), 'handoff')

/**
 * 한 프로젝트의 노트 폴더. 프로젝트 id도 여기서는 경로 조각이다 — **조각 하나가 아니면 거절한다** (#132).
 * 경계(`ProjectId`)가 이미 거르지만, 경로를 만드는 쪽이 스스로도 확인한다 — 청소는 RPC를 거치지 않는다.
 */
export function handoffNoteDir(projectId: string): string {
  if (!isProjectId(projectId)) {
    throw Object.assign(new Error(`Not a project id: ${projectId}`), { code: 'internal' })
  }
  return join(root(), projectId)
}

/** 넘기는 세션 하나의 노트 — 이름이 세션 id라 동시에 도는 두 인수인계가 자리를 다투지 않는다 (#104) */
export function handoffNotePath(projectId: string, sessionId: string): string {
  if (!isSessionId(sessionId)) {
    throw Object.assign(new Error(`Not a session id: ${sessionId}`), { code: 'internal' })
  }
  return join(handoffNoteDir(projectId), `${sessionId}.md`)
}

/** 노트를 놓고 그 절대 경로를 돌려준다. 쓰는 것은 언제나 host다 — 에이전트는 이 폴더에 쓰지 않는다 */
export async function writeHandoffNote(projectId: string, sessionId: string, text: string): Promise<string> {
  const path = handoffNotePath(projectId, sessionId)
  await mkdir(handoffNoteDir(projectId), { recursive: true })
  // 있던 것부터 걷는다 (#104) — 그 자리에 링크가 있으면 쓰기가 링크를 따라간다
  await rm(path, { force: true })
  await writeFile(path, text, 'utf8')
  return path
}

/**
 * 주인 없는 노트를 지운다 (#106). 누가 주인인지는 부르는 쪽이 안다(`owned`).
 *
 * **디렉토리와 보통 파일만 본다.** 폴더도 파일도 host만 만들지만, 링크를 따라가 지우는 청소가 이 이슈의
 * 시작이었다 — `withFileTypes`의 항목은 링크를 따라가지 않고 링크 자신으로 답하므로, 링크는 폴더로도
 * 파일로도 보이지 않는다.
 *
 * **빈 폴더는 남긴다** (#104) — 폴더를 통째로 가져가는 청소는 그 사이에 시작된 인수인계의 글을 함께 데려간다.
 */
export async function sweepHandoffNotes(owned: (sessionId: string) => boolean, projectId?: string): Promise<void> {
  let dirs: string[]
  try {
    dirs = projectId
      ? [projectId]
      : (await readdir(root(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return // 인수인계를 한 적 없다 — 지울 것도 없다
  }
  for (const pid of dirs) {
    let dir: string
    try {
      dir = handoffNoteDir(pid)
    } catch {
      continue // 우리가 짓지 않은 이름이다 — 손대지 않는다
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const owner = e.name.slice(0, -'.md'.length)
      if (owned(owner)) continue
      await rm(join(dir, e.name), { force: true }).catch(() => {})
    }
  }
}
