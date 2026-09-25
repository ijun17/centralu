import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { folderFingerprint, walkCode } from './fingerprint.js'

/**
 * git 밖의 앱의 판 (M4 E-1) — 사용자 폴더 앱(가져온 앱 포함)은 저장소에 없으니 되돌릴 길이 없다. 그래서 **코드가 바뀌어 뜰 때마다**
 * 앱 폴더를 한 벌 떠 두고, 최근 몇 벌만 남긴다. 프로젝트 앱은 git이 판이다(여기서 다루지 않는다).
 *
 * 무엇을 뜨나: 폴더 지문(`fingerprint.ts`)이 재는 것과 **같은 걸음**(`walkCode`) — 점으로 시작하는 이름과 `node_modules`는 앱의
 * 코드가 아니라서 뜨지도, 되돌리지도 않는다. 그래서 스냅샷의 지문은 그 코드의 지문(목록의 `codeStamp`의 원본)과 같고, "지금 이
 * 판이다"를 지문으로 가릴 수 있다. 되돌릴 때 큰 파일의 시각을 되살리는 것도 같은 까닭이다(큰 파일은 크기와 시각으로 잰다).
 *
 * 언제 뜨나: 앱이 **뜨기 직전**(그 코드가 이제 돌 코드다), 그리고 가져온 앱이 들어올 때와 되돌리기 직전. 같은 지문의 판이 이미 있으면
 * 다시 뜨지 않는다 — 같은 코드로 다시 뜨는 앱(쉬다 깸, 죽었다 삶)은 판을 늘리지 않는다.
 *
 * 자리: `<데이터 폴더>/app-versions/_user/<앱 id>/<때>-<지문 앞 16자>/` 아래 `files/`와 `meta.json`. 앱 폴더 밖이라 앱의 코드가 제
 * 판을 고치지 못하고, 앱을 지워도(휴지통) 남는다.
 */

export const VERSIONS_KEPT = 5
export const VERSIONS_REL = 'app-versions'
/** 한 판의 크기 상한 — 넘으면 뜨지 않고 그렇다고 적는다(앱이 커다란 자료를 제 폴더에 두는 경우) */
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024

export type Snapshot = {
  id: string
  at: number
  /** 이 판의 폴더 지문 전체 */
  stamp: string
  files: number
  bytes: number
  /** 왜 떴나 — started · imported · before restore */
  reason: string
}

export class AppVersions {
  constructor(private root: string) {}

  /** 한 앱의 판, 최근 것부터 */
  list(appId: string): Snapshot[] {
    const dir = join(this.root, appId)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out: Snapshot[] = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      try {
        out.push(JSON.parse(readFileSync(join(dir, name, 'meta.json'), 'utf8')) as Snapshot)
      } catch {
        // 반쯤 지운 판이다 — 목록에 세우지 않는다
      }
    }
    return out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
  }

  /**
   * 지금 폴더를 한 벌 뜬다 — 같은 지문의 판이 이미 있으면 뜨지 않고 null. `stamp`는 부른 쪽이 방금 잰 지문이다(다시 재지 않게).
   * 떠 둔 사본의 지문을 다시 재어 그 판의 지문으로 적는다: 뜨는 사이에 파일이 바뀌었어도 판의 지문은 판의 내용과 맞는다.
   */
  capture(appId: string, dir: string, reason: string, stamp = folderFingerprint(dir)): Snapshot | null {
    const kept = this.list(appId)
    if (kept.some((s) => s.stamp === stamp)) return null
    const appRoot = join(this.root, appId)
    mkdirSync(appRoot, { recursive: true })
    const tmp = join(appRoot, `.tmp-${randomUUID()}`)
    const files = join(tmp, 'files')
    mkdirSync(files, { recursive: true })
    let count = 0
    let bytes = 0
    try {
      walkCode(dir, {
        unreadable: () => {},
        more: () => {},
        dir: (r) => mkdirSync(join(files, r), { recursive: true }),
        file: (r) => {
          const from = join(dir, r)
          const st = statSync(from)
          bytes += st.size
          if (bytes > SNAPSHOT_MAX_BYTES) throw new Error(`the app folder is larger than ${SNAPSHOT_MAX_BYTES} bytes`)
          copyFileSync(from, join(files, r))
          utimesSync(join(files, r), st.atime, st.mtime)
          count++
        },
      })
      const actual = folderFingerprint(files)
      if (kept.some((s) => s.stamp === actual)) {
        rmSync(tmp, { recursive: true, force: true })
        return null
      }
      const at = Date.now()
      const id = `${at}-${actual.slice(0, 16)}`
      const snap: Snapshot = { id, at, stamp: actual, files: count, bytes, reason }
      writeFileSync(join(tmp, 'meta.json'), JSON.stringify(snap, null, 2))
      renameSync(tmp, join(appRoot, id))
      this.prune(appId)
      return snap
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true })
      throw e
    }
  }

  /**
   * 판 하나를 앱 폴더에 되쓴다. 판이 다루는 것(지문이 재는 것)만 바꾼다: 판에 없는 코드 파일은 지우고, 판의 파일은 시각까지 되살려
   * 쓴다. 점으로 시작하는 이름과 `node_modules`는 건드리지 않는다 — 판에 없던 것이지 지운 것이 아니다.
   */
  restore(appId: string, id: string, dir: string): Snapshot {
    const snap = this.list(appId).find((s) => s.id === id)
    if (!snap) throw new Error('That version is no longer kept')
    const files = join(this.root, appId, id, 'files')
    const want = new Set<string>()
    const wantDirs = new Set<string>()
    walkCode(files, { unreadable: () => {}, more: () => {}, dir: (r) => void wantDirs.add(r), file: (r) => void want.add(r) })
    // 판에 없는 코드 파일을 지운다 — 판을 되살린 폴더의 지문이 판의 지문과 같아야 한다
    const extraDirs: string[] = []
    walkCode(dir, {
      unreadable: () => {},
      more: () => {},
      dir: (r) => void (wantDirs.has(r) || extraDirs.push(r)),
      file: (r) => void (want.has(r) || unlinkSync(join(dir, r))),
    })
    for (const r of extraDirs.sort((a, b) => b.length - a.length)) {
      try {
        rmdirSync(join(dir, r))
      } catch {
        // 비어 있지 않다 — 그 안에 판이 다루지 않는 것(점 이름, node_modules)이 있다. 두고 간다
      }
    }
    for (const r of wantDirs) mkdirSync(join(dir, r), { recursive: true })
    for (const r of want) {
      const from = join(files, r)
      const to = join(dir, r)
      mkdirSync(dirname(to), { recursive: true })
      if (existsSync(to) && statSync(to).isDirectory()) rmSync(to, { recursive: true, force: true })
      copyFileSync(from, to)
      const st = statSync(from)
      utimesSync(to, st.atime, st.mtime)
    }
    return snap
  }

  /** 최근 판만 남긴다 */
  private prune(appId: string): void {
    for (const old of this.list(appId).slice(VERSIONS_KEPT)) rmSync(join(this.root, appId, old.id), { recursive: true, force: true })
  }
}
