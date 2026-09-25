import { join } from 'node:path'
import type { ExternalAppInfo } from '@cc/protocol'
import { DirWatchers } from '../../dev-services/watch.js'
import { PROJECT_APPS_REL, USER_APPS_REL, scanApps, type ScannedApp } from './discovery.js'
import type { AppManifest } from './manifest.js'

/**
 * 외부 앱 런타임 (M4 A) — **코어가 외부 앱에 대해 아는 문은 이 파일 하나다.**
 *
 * 내장 앱(`registry.ts`의 HOST_APPS)은 컴파일된 모듈이고, 외부 앱은 실행 중에 발견되는
 * 폴더와 그 폴더가 띄우는 프로세스다. 둘은 사는 방식이 달라 명부도 다르지만, 코어가 앱을
 * 아는 길이 좁아야 한다는 규칙(#81)은 같다 — 그래서 이 런타임은 코어를 임포트하지 않고,
 * 필요한 것(프로젝트 목록과 신뢰, 데이터 폴더)을 `ExternalAppsDeps`로 **받는다.**
 * #97이 UI 런타임에서 한 뒤집기와 같다: 런타임이 필요한 것을 선언하고 host가 채운다.
 *
 * 저장소(Store)도 임포트하지 않는다. 프로젝트와 신뢰는 함수로 묻는다 — 매번 묻는 이유는
 * 정본이 저장소 하나라서다. 여기에 사본을 들고 있으면 신뢰를 끈 뒤에도 사본이 "예"라고 답한다.
 */

/** 사용자 폴더 앱의 범위 이름. 프로젝트 id는 UUID라 겹치지 않는다 */
const USER_SCOPE = '~'

export type AppRef = { projectId: string | null; appId: string }

export type ExternalAppsDeps = {
  /** 등록된 프로젝트의 뿌리와 신뢰 — 부를 때마다 저장소에서 읽는다 */
  projects(): readonly { id: string; path: string; trusted: boolean }[]
  /** host의 데이터 폴더 (`dataRoot()`) — 사용자 앱과 앱 데이터가 이 아래에 산다 */
  dataRoot: string
  /** 외부 앱이 가져갈 수 없는 id — 내장 앱의 id. 같은 이름이면 `apps.invoke`가 갈라진다 */
  reservedIds: readonly string[]
  /** 폴더 감시 플러시 간격 (테스트가 줄인다) */
  watchFlushMs?: number
}

type Scope = { key: string; projectId: string | null; root: string; trusted: boolean }

type AppEntry = {
  ref: AppRef
  scope: Scope
  /** 발견이 본 그대로 — 다음 훑기와 비교하는 기준이다 */
  found: ScannedApp
  dir: string
  /** 발견의 판정 위에 런타임의 판정(예약된 id)까지 얹은 결과 */
  manifest: AppManifest | null
  error: string | null
  warnings: string[]
}

export class ExternalApps {
  /** 범위 키 → (앱 id → 항목) */
  private scopes = new Map<string, { scope: Scope; apps: Map<string, AppEntry> }>()
  private watchers: DirWatchers
  private disposed = false

  constructor(private deps: ExternalAppsDeps) {
    this.watchers = new DirWatchers((key) => this.rescan(key), deps.watchFlushMs)
  }

  /**
   * 프로젝트 목록과 신뢰를 다시 읽고 전부 다시 훑는다.
   *
   * 기동할 때 한 번, 그리고 프로젝트가 늘거나 줄거나 신뢰가 바뀔 때 부른다(RPC 문이 부른다).
   * 폴더 안의 변화는 감시가 따로 따라간다 — 이 함수는 "어느 폴더를 볼 것인가"를 정한다.
   */
  refresh(): void {
    if (this.disposed) return
    const want = new Map<string, Scope>()
    want.set(USER_SCOPE, { key: USER_SCOPE, projectId: null, root: this.deps.dataRoot, trusted: true })
    for (const p of this.deps.projects()) {
      want.set(p.id, { key: p.id, projectId: p.id, root: p.path, trusted: p.trusted })
    }
    for (const key of [...this.scopes.keys()]) {
      if (!want.has(key)) this.dropScope(key)
    }
    for (const scope of want.values()) {
      const cur = this.scopes.get(scope.key)
      if (cur) cur.scope = scope
      else this.scopes.set(scope.key, { scope, apps: new Map() })
      this.rescan(scope.key)
    }
  }

  /** 발견된 외부 앱 전부 — 신뢰하지 않은 프로젝트의 앱과 깨진 매니페스트도 이유와 함께 선다 */
  list(): ExternalAppInfo[] {
    const out: ExternalAppInfo[] = []
    for (const { apps } of this.scopes.values()) {
      for (const e of apps.values()) out.push(this.info(e))
    }
    return out
  }

  dispose(): void {
    this.disposed = true
    this.watchers.close()
    this.scopes.clear()
  }

  private info(e: AppEntry): ExternalAppInfo {
    const m = e.manifest
    return {
      appId: e.ref.appId,
      projectId: e.ref.projectId,
      dir: e.dir,
      name: m?.name ?? null,
      version: m?.version ?? null,
      description: m?.description ?? null,
      home: m?.home ?? null,
      trusted: e.scope.trusted,
      status: this.status(e),
      error: e.error,
      warnings: e.warnings,
    }
  }

  private status(e: AppEntry): ExternalAppInfo['status'] {
    if (!e.manifest) return 'invalid'
    if (!e.scope.trusted) return 'untrusted'
    return 'stopped'
  }

  private rescan(key: string): void {
    const held = this.scopes.get(key)
    if (!held || this.disposed) return
    const { scope } = held
    const result =
      scope.projectId === null
        ? scanApps(scope.root, USER_APPS_REL, [])
        : scanApps(scope.root, PROJECT_APPS_REL, ['', '.centralu'])
    const seen = new Set<string>()
    for (const found of result.apps) {
      seen.add(found.folder)
      const prev = held.apps.get(found.folder)
      if (prev && prev.found.hash === found.hash && prev.found.error === found.error) {
        prev.scope = scope
        continue
      }
      held.apps.set(found.folder, this.entry(scope, found))
    }
    for (const id of [...held.apps.keys()]) {
      if (!seen.has(id)) held.apps.delete(id)
    }
    this.watchers.setWatched(key, scope.root, result.watch)
  }

  private entry(scope: Scope, found: ScannedApp): AppEntry {
    let { manifest, error } = found
    if (manifest && this.deps.reservedIds.includes(manifest.id)) {
      // 내장 앱과 같은 id면 `apps.invoke`가 어느 쪽을 부를지 갈린다 — 먼저 선 쪽이 이긴다
      error = `"${manifest.id}"는 내장 앱의 이름입니다 — 다른 id를 쓰세요`
      manifest = null
    }
    return {
      ref: { projectId: scope.projectId, appId: found.folder },
      scope,
      found,
      dir: found.dir,
      manifest,
      error,
      warnings: found.warnings,
    }
  }

  private dropScope(key: string): void {
    this.watchers.setWatched(key, this.scopes.get(key)?.scope.root ?? join(this.deps.dataRoot, USER_APPS_REL), [])
    this.scopes.delete(key)
  }
}
