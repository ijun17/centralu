import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * 앱 폴더의 지문 (M4 C-4) — "앱이 뜬 뒤로 폴더가 바뀌었나"를 이것 하나로 답한다.
 *
 * 폴더 감시(fs 이벤트)에 기대지 않는 이유: 감시는 펼쳐진 폴더만 보고(`DirWatchers` — 재귀가 아니다), 이벤트는
 * 합쳐지거나 빠질 수 있다. 반영이 필요한 순간(만드는 세션의 턴이 끝났다)에 지금 폴더를 직접 재면 이벤트를 몇 개
 * 놓쳤든 답이 맞다. 감시는 "언제 재 볼까"만 알려 준다(만드는 세션이 없을 때).
 *
 * 작은 파일은 **내용**으로 잰다: `touch`나 같은 내용의 체크아웃은 앱을 바꾸지 않았으니 다시 띄울 까닭이 없다.
 * 큰 파일은 크기와 시각으로 — 폴더 하나를 재는 값이 몇 밀리초를 넘지 않게.
 *
 * 건너뛰는 것: 점으로 시작하는 이름(`.git`, `.gitattributes` — 앱의 동작이 아니다)과 `node_modules`(템플릿은
 * 설치하지 않는다. 누가 설치했어도 수만 개를 매번 걷지 않는다). 파일 수와 깊이에 상한이 있다.
 */

const CONTENT_MAX_BYTES = 1024 * 1024
const MAX_FILES = 2_000
const MAX_DEPTH = 8

/**
 * 지문이 재는 것을 걷는다 — 지문과 스냅샷(E-1, `versions.ts`)이 **같은 걸음**을 쓴다. 스냅샷이 담는 파일과 지문이 재는 파일이 다르면,
 * 되돌린 뒤의 지문이 그 스냅샷의 지문과 맞지 않아 "지금 이 판"을 가리킬 수 없다.
 *
 * 건너뛰는 것·상한은 위 머리말 그대로다. 링크는 파일도 폴더도 아니라서 걷지 않는다(`Dirent`는 링크를 따라가지 않는다).
 */
export type CodeVisit = {
  /** 못 읽은 폴더 — 사라진 폴더와 있는 폴더가 같은 모양이 되지 않게 지문은 이것도 잰다 */
  unreadable(rel: string): void
  dir(rel: string): void
  /** 파일 하나 (앱 폴더 기준 상대 경로) */
  file(rel: string): void
  /** 파일 수 상한을 넘었다 — 그 폴더의 나머지는 건너뛴다 */
  more(): void
}

export function walkCode(dir: string, v: CodeVisit): void {
  let files = 0
  const walk = (rel: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true })
    } catch {
      v.unreadable(rel)
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        v.dir(r)
        if (depth < MAX_DEPTH) walk(r, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      if (++files > MAX_FILES) {
        v.more()
        return
      }
      v.file(r)
    }
  }
  walk('', 0)
}

export function folderFingerprint(dir: string): string {
  const h = createHash('sha256')
  walkCode(dir, {
    unreadable: (rel) => void h.update(`!${rel}\n`), // 못 읽은 것도 모양이다 — 사라진 폴더와 있는 폴더가 같은 지문이 되지 않게
    dir: (r) => void h.update(`d ${r}\n`),
    more: () => void h.update('…more files\n'),
    file: (r) => {
      try {
        const path = join(dir, r)
        const st = statSync(path)
        if (st.size <= CONTENT_MAX_BYTES) h.update(`f ${r} `).update(readFileSync(path)).update('\n')
        else h.update(`F ${r} ${st.size} ${st.mtimeMs}\n`)
      } catch {
        h.update(`? ${r}\n`) // 재는 사이에 사라졌다
      }
    },
  })
  return h.digest('hex')
}
