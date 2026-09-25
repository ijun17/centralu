import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppReview, ExternalAppInfo } from '@cc/protocol'
import { canonicalJson } from './runs.js'
import { ImportBook, reviewKey } from './import-book.js'
import {
  IMPORT_LIMITS,
  ImportRefused,
  classifySource,
  discard,
  downloadZip,
  isZip,
  listAppFiles,
  readStagedManifest,
  reviewOf,
  stageLocal,
  stageZip,
  type ImportLimits,
  type StagedFiles,
} from './imports.js'
import type { AppManifest } from './manifest.js'
import { ensureDirInside } from './scaffold.js'

/**
 * 건네기의 host 쪽 (M4 E) — 밖에서 가져온 앱의 대기실과 사람의 확인.
 *
 * 런타임은 앱의 수명과 호출의 한 길을 들고, 이 자리는 "이 앱을 들여도 되나, 돌려도 되나"를 든다. 둘을 나눈 이유: 런타임은
 * 중개(D)·반영(C-4)·수명이 함께 사는 파일이라, 건네기의 규칙이 그 사이에 흩어지면 어느 검사가 어디 있는지 찾기 어렵다. 런타임이
 * 이 자리에 묻는 것은 둘뿐이다 — 이 앱이 확인을 기다리나(`gate`), 가져온 앱의 표시(`imported`).
 *
 * 순서: 준비(`prepare`: 옮겨 담고 판정하고 볼 것을 만든다) → 사람이 본다 → 들이기(`commit`: 사용자 폴더로 옮기고 꺼진 채로 적는다,
 * 원하면 그 자리에서 확인까지) → 나중에 `server`·`uses`가 바뀌면 다시 묻는다(`review` → `enable`).
 */

export type HandoverHost = {
  dataRoot: string
  reservedIds: readonly string[]
  /** 사용자 폴더를 지금 다시 훑는다 — 들인 앱이 곧바로 목록에 서도록 */
  rescanUser(): void
  /** 사용자 폴더 앱 하나의 지금 모습 — 없으면 null. 매니페스트가 틀렸으면 manifest가 null이다 */
  userApp(appId: string): { dir: string; manifest: AppManifest | null } | null
  /** 목록이 달라졌을 수 있다(상태·표시) */
  changed(): void
}

export type HandoverOptions = {
  /** 상한 (시험이 줄인다) */
  limits?: Partial<ImportLimits>
  /** 내려받기 (시험이 가짜를 꽂는다 — https 서버를 띄우지 않고 넘김·크기·내용을 시험한다) */
  fetch?: typeof fetch
  /** 대기실이 스스로 치워지기까지 */
  stagingMs?: number
}

/** 대기실 — 데이터 폴더 안이라 사용자 폴더로 옮기는 것이 같은 파일 시스템의 이름 바꾸기다. 발견은 여기를 훑지 않는다 */
export const STAGING_REL = 'app-staging'
const STAGING_MS = 30 * 60_000

type Staged = { home: string; appDir: string; review: AppReview; timer: NodeJS.Timeout }

const NOT_ENABLED = 'This app was imported and is not enabled yet. Review what it runs, then enable it'
const CHANGED = 'This app changed what it runs or what it uses since you enabled it. Review it and enable it again'

export class AppHandover {
  private book: ImportBook
  private staged = new Map<string, Staged>()
  private limits: ImportLimits
  private stagingRoot: string

  constructor(
    private host: HandoverHost,
    private opts: HandoverOptions = {},
  ) {
    this.book = new ImportBook(host.dataRoot)
    this.limits = { ...IMPORT_LIMITS, ...opts.limits }
    this.stagingRoot = join(host.dataRoot, STAGING_REL)
    // 지난 host가 남긴 대기실 — 들이지 않은 것이라 버린다(다시 가져오면 된다)
    rmSync(this.stagingRoot, { recursive: true, force: true })
  }

  /**
   * 이 앱이 사람의 확인을 기다리나 — 그 까닭, 아니면 null. **부를 때마다** 표시와 지금의 매니페스트를 대 본다: 매니페스트의
   * `server`·`uses`가 바뀌는 순간(편집기, 만드는 세션, 되돌리기) 다음 호출부터 막힌다.
   */
  gate(appId: string, dir: string, manifest: AppManifest): string | null {
    const mark = this.book.get(appId, dir)
    if (!mark) return null
    if (mark.confirmed && mark.confirmed.key === reviewKey(manifest)) return null
    return mark.confirmed ? CHANGED : NOT_ENABLED
  }

  /** 목록에 실을 표시 — 가져온 앱이 아니면 없다 */
  imported(appId: string, dir: string): ExternalAppInfo['imported'] {
    const mark = this.book.get(appId, dir)
    return mark ? { source: mark.source, at: mark.importedAt, confirmedAt: mark.confirmed?.at ?? null } : undefined
  }

  /**
   * 가져올 준비 — 옮겨 담고, 판정하고, 사람이 볼 것을 만든다. 내려받는 것은 이 기계의 임시 폴더로 받아 풀고 지운다. 실패하면
   * 대기실을 치우고 그 이유를 던진다(이유가 곧 창에 서는 말이다).
   */
  async prepare(raw: string): Promise<{ token: string; review: AppReview }> {
    const source = classifySource(raw)
    const token = randomUUID()
    const home = join(this.stagingRoot, token)
    mkdirSync(home, { recursive: true })
    const appDir = join(home, 'app')
    let tmp: string | null = null
    try {
      let files: StagedFiles
      if (source.kind === 'https') {
        tmp = mkdtempSync(join(tmpdir(), 'centralu-import-'))
        const buf = await downloadZip(source.url, tmp, this.limits, this.opts.fetch)
        if (!isZip(buf)) throw new ImportRefused(`${source.label} did not send a .zip file`)
        files = stageZip(buf, appDir, this.limits)
      } else {
        files = stageLocal(source.path, appDir, this.limits)
      }
      const { manifest, warnings } = readStagedManifest(appDir, this.host.reservedIds)
      this.refuseTaken(manifest.id)
      const review = reviewOf(manifest, files, { source: source.label, warnings })
      const timer = setTimeout(() => this.cancel(token), this.opts.stagingMs ?? STAGING_MS)
      timer.unref()
      this.staged.set(token, { home, appDir, review, timer })
      return { token, review }
    } catch (e) {
      discard(home)
      throw e instanceof ImportRefused ? e : new ImportRefused(`Could not import from ${source.label}: ${(e as Error).message}`)
    } finally {
      if (tmp) discard(tmp)
    }
  }

  /**
   * 대기실의 앱을 사용자 폴더로 들인다 — **꺼진 채로.** `enable`이면 그 자리에서 확인을 적는데, 열쇠는 준비할 때 사람에게 보인 그
   * 열쇠여야 한다. 들이기 직전에 대기실의 매니페스트를 다시 읽어 그 열쇠와 대 본다(검사한 것이 곧 들이는 것이다).
   * @returns 들인 앱의 id
   */
  commit(token: string, opts: { enable: boolean; reviewKey?: string }): string {
    const s = this.staged.get(token)
    if (!s) throw new ImportRefused('This import is no longer waiting (it was cancelled, or 30 minutes passed). Review it again')
    const id = s.review.appId
    if (opts.enable && opts.reviewKey !== s.review.reviewKey) throw new ImportRefused('What would be enabled is not what you reviewed. Review it again')
    const { manifest } = readStagedManifest(s.appDir, this.host.reservedIds)
    if (reviewKey(manifest) !== s.review.reviewKey) throw new ImportRefused('The app changed while it was waiting. Review it again')
    this.refuseTaken(id)
    const dir = join(ensureDirInside(this.host.dataRoot, ['apps']), id)
    renameSync(s.appDir, dir)
    this.book.mark(id, dir, s.review.source)
    if (opts.enable) this.book.confirm(id, manifest)
    this.cancel(token)
    this.host.rescanUser()
    return id
  }

  /** 그만둔다 — 대기실을 치운다. 이미 없으면 조용히 지나간다 */
  cancel(token: string): void {
    const s = this.staged.get(token)
    if (!s) return
    clearTimeout(s.timer)
    this.staged.delete(token)
    discard(s.home)
  }

  /**
   * 들어온 앱을 다시 본다 — 켜지 않은 가져온 앱이나, 켠 뒤 `server`·`uses`가 바뀐 앱. 다시 묻는 것이면 켠 때의 선언을 함께 싣는다:
   * "무엇이 바뀌었나"가 다시 묻는 까닭이다.
   */
  review(appId: string): AppReview {
    this.host.rescanUser()
    const app = this.host.userApp(appId)
    if (!app) throw new ImportRefused(`No app named "${appId}" in your apps`)
    if (!app.manifest) throw new ImportRefused("This app's manifest is invalid, so there is nothing to review")
    const m = app.manifest
    const mark = this.book.get(appId, app.dir)
    const was = mark?.confirmed ?? null
    const changed =
      was && was.key !== reviewKey(m)
        ? {
            server: canonicalJson(was.server) !== canonicalJson({ command: m.server.command, args: m.server.args }),
            uses: canonicalJson(was.uses) !== canonicalJson(m.uses),
            was: { server: { command: was.server.command, args: was.server.args }, uses: was.uses },
          }
        : null
    return reviewOf(m, listAppFiles(app.dir, this.limits), { source: mark?.source ?? app.dir, warnings: [], changed })
  }

  /**
   * 가져온 앱을 켠다 — 사람이 본 창의 열쇠가 지금의 매니페스트와 같을 때만. 그 사이 바뀌었으면 거절한다: 사람이 보지 않은 명령을
   * "켰다"로 적지 않는다.
   */
  enable(appId: string, key: string): void {
    this.host.rescanUser()
    const app = this.host.userApp(appId)
    if (!app) throw new ImportRefused(`No app named "${appId}" in your apps`)
    if (!app.manifest) throw new ImportRefused("This app's manifest is invalid; fix it before enabling it")
    if (!this.book.get(appId, app.dir)) throw new ImportRefused('This app was not imported, so it needs no enabling')
    if (reviewKey(app.manifest) !== key) throw new ImportRefused('This app changed since you reviewed it. Review it again')
    this.book.confirm(appId, app.manifest)
    this.host.changed()
  }

  /** 앱이 사용자 폴더에서 치워졌다 — 표시도 걷는다 */
  forget(appId: string): void {
    this.book.drop(appId)
  }

  dispose(): void {
    for (const token of [...this.staged.keys()]) this.cancel(token)
  }

  /** 이미 있는 id — 틀린 매니페스트로 서 있는 폴더라도 사람의 것이다. 덮어쓰지 않는다(새 앱과 같다) */
  private refuseTaken(id: string): void {
    this.host.rescanUser()
    if (this.host.userApp(id) || existsSync(join(this.host.dataRoot, 'apps', id))) {
      throw new ImportRefused(`An app with the id "${id}" is already in your apps. Remove it first, or change the id in its manifest`)
    }
  }
}
