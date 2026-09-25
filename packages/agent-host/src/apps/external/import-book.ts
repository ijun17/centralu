import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppManifest } from './manifest.js'
import { canonicalJson } from './runs.js'

/**
 * 가져온 앱의 표시와 사람의 확인 (M4 E-3, 결정 3) — **host 쪽에** 산다.
 *
 * 사용자 폴더 앱은 사람이 거기 둔 것이라 신뢰한다(결정 3). 밖에서 가져온 앱만 따로 묻는다: 가져온 앱은 꺼진 채 들어오고,
 * 사람이 무엇을 돌리는지(`server`)와 무엇을 쓰겠다는지(`uses`)를 본 뒤 켠다. 켠 기록은 그때 본 것의 열쇠(`reviewKey`)다 —
 * 매니페스트의 `server`나 `uses`가 나중에 바뀌면 열쇠가 맞지 않아 다시 묻는다.
 *
 * 표시가 앱 폴더 밖(데이터 폴더의 파일 하나)에 있는 이유: 앱 폴더 안의 표시는 앱의 코드가 지우거나 고칠 수 있고, 가져온 묶음이
 * "이미 확인됨"을 들고 들어올 수도 있다. 표시는 그 폴더의 inode에 묶는다 — 같은 id로 다시 생긴 다른 폴더(지우고 새로 만든
 * 앱)에 옛 표시가 붙지 않는다. 이름을 바꾸거나 옮겨도(같은 파일 시스템) inode는 남는다.
 */

export const IMPORTS_FILE = 'app-imports.json'

export type ImportMark = {
  /** 어디서 왔나 — 사람에게 보이는 그대로(경로나 https 주소) */
  source: string
  importedAt: number
  /** 가져온 폴더의 inode — 이 폴더일 때만 표시가 걸린다 */
  ino: number
  /** 사람이 켠 기록 — 켤 때 본 server·uses와 그 열쇠. 켜지 않았으면 null */
  confirmed: { key: string; at: number; server: AppManifest['server']; uses: AppManifest['uses'] } | null
}

type Doc = Record<string, ImportMark>

/**
 * 사람이 본 것의 열쇠 — 매니페스트의 `server`(명령과 인자)와 `uses`. 키 순서를 고정한 JSON의 해시다: 같은 선언이 키 순서만
 * 달라 "바뀌었다"로 읽히면 사람은 까닭 없이 다시 묻는 창을 본다.
 */
export function reviewKey(m: Pick<AppManifest, 'server' | 'uses'>): string {
  return createHash('sha256')
    .update(canonicalJson({ server: { command: m.server.command, args: m.server.args }, uses: m.uses }))
    .digest('hex')
}

export class ImportBook {
  private path: string
  private doc: Doc

  constructor(dataRoot: string) {
    this.path = join(dataRoot, IMPORTS_FILE)
    this.doc = this.read()
  }

  /** 이 폴더에 걸린 표시 — 가져온 앱이 아니거나, 같은 id의 다른 폴더면 null */
  get(appId: string, dir: string): ImportMark | null {
    const m = this.doc[appId]
    if (!m) return null
    try {
      return statSync(dir).ino === m.ino ? m : null
    } catch {
      return null
    }
  }

  /** 가져왔다 — 꺼진 채로 적는다 */
  mark(appId: string, dir: string, source: string, at = Date.now()): void {
    this.doc[appId] = { source, importedAt: at, ino: statSync(dir).ino, confirmed: null }
    this.write()
  }

  /** 사람이 켰다 — 그때 본 선언을 열쇠와 함께 적는다 */
  confirm(appId: string, manifest: Pick<AppManifest, 'server' | 'uses'>, at = Date.now()): void {
    const m = this.doc[appId]
    if (!m) return
    m.confirmed = { key: reviewKey(manifest), at, server: manifest.server, uses: manifest.uses }
    this.write()
  }

  drop(appId: string): void {
    if (!(appId in this.doc)) return
    delete this.doc[appId]
    this.write()
  }

  private read(): Doc {
    if (!existsSync(this.path)) return {}
    try {
      const doc = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Doc) : {}
    } catch {
      /*
       * 깨진 파일 — 표시를 잃으면 가져온 앱이 확인 없이 도는 쪽으로 기운다. 그래서 읽지 못한 파일은 옆으로 치워 두고 알린다.
       * 옮겨 둔 원본에서 사람이 되살릴 수 있다. (확인을 강제로 모두 거두는 길은 없다: 무엇이 가져온 앱이었는지가 그 파일에 있다)
       */
      const aside = `${this.path}.unreadable-${Date.now()}`
      try {
        renameSync(this.path, aside)
      } catch {
        // 옮기지 못해도 읽지 못한 것은 같다
      }
      console.error(`[apps] ${IMPORTS_FILE} is unreadable; moved to ${aside}. Imported apps lost their marks`)
      return {}
    }
  }

  /** 임시 파일을 0600으로 만들고 옮긴다 — 출처 주소에 토큰이 든 링크가 있을 수 있다 */
  private write(): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.doc, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
    chmodSync(this.path, 0o600)
  }
}
