import { watch, type FSWatcher } from 'node:fs'
import { safeJoin } from './fs.js'

/**
 * 파일 트리의 눈 (#34) — **펼쳐진 디렉토리만** 감시한다.
 *
 * 저장소 전체를 재귀로 감시하지 않는 이유가 이 설계의 전부다. 트리는 lazy라서
 * 열어본 디렉토리만 읽는데, 감시가 재귀면 node_modules까지 걷게 되어 lazy를 우리
 * 손으로 되무른다 (Linux inotify는 재귀가 없어서 디렉토리마다 워치 하나 —
 * max_user_watches 고갈, 그 유명한 ENOSPC). 펼쳐진 집합은 화면에 실제로 보이는
 * 몇 개~몇십 개라, 세 플랫폼 모두에서 값이 같아진다.
 *
 * 이벤트는 디렉토리별로 모아 **일정 간격으로 한 번** 내보낸다. 실측: 파일 500개
 * 쓰기가 36ms에 이벤트 501발 — 이벤트마다 다시 읽으면 목록 요청 500개다. 뒤로만
 * 미루는 디바운스는 npm install처럼 수십 초 잇는 버스트에서 끝날 때까지 화면이
 * 굶는다. 간격 플러시는 버스트 중에도 최대 3~4회/초로 따라간다.
 */

/**
 * 프로젝트당 감시 상한. 펼쳐진 폴더가 여기 닿는 일은 실사용에서 없지만
 * (수백 개를 손으로 펼쳐야 한다), 닿으면 **조용히 자르지 않고** 몇 개를 지키는지
 * 돌려준다 — 부르는 쪽이 그 수로 잘림을 안다.
 */
export const MAX_WATCHED_DIRS = 256

export class DirWatchers {
  /** projectId → (상대경로 → 워처) */
  private byProject = new Map<string, Map<string, FSWatcher>>()
  private pending = new Map<string, Set<string>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false

  constructor(
    private onChange: (projectId: string, dirs: string[]) => void,
    private flushMs = 300,
  ) {}

  /**
   * 이 프로젝트의 감시 집합을 **통째로** 이걸로 만든다 (projects.reorder와 같은 문법).
   * "이걸 더하고 저걸 빼고"식이면 화면과 감시가 어긋난 채로도 오류가 없다 —
   * 전체를 말하게 하면 어긋남 자체가 표현이 안 된다.
   */
  setWatched(projectId: string, root: string, rels: readonly string[]): number {
    if (this.closed) return 0
    const want = new Set([...new Set(rels)].slice(0, MAX_WATCHED_DIRS))
    const cur = this.byProject.get(projectId) ?? new Map<string, FSWatcher>()
    this.byProject.set(projectId, cur)

    for (const [rel, w] of cur) {
      if (!want.has(rel)) {
        w.close()
        cur.delete(rel)
      }
    }

    for (const rel of want) {
      if (cur.has(rel)) continue
      let abs: string
      try {
        // 트리의 다른 fs 경로들과 같은 규칙 — 프로젝트 밖은 감시 대상이 될 수 없다
        abs = safeJoin(root, rel)
      } catch {
        continue
      }
      let w: FSWatcher
      try {
        w = watch(abs, () => this.schedule(projectId, rel))
      } catch {
        /*
         * 이미 사라진 디렉토리다 (Finder에서 지운 폴더가 펼쳐져 있던 경우).
         * 감시는 못 하지만 **그 사실이 곧 알릴 거리다** — 한 번 알리면 UI가
         * 다시 읽고, 빈 목록과 부모의 재조회로 화면에서 걷힌다.
         */
        this.schedule(projectId, rel)
        continue
      }
      w.on('error', () => {
        // 감시 중이던 디렉토리가 사라졌다 — 워처는 걷고, 화면에는 알린다
        w.close()
        cur.delete(rel)
        this.schedule(projectId, rel)
      })
      cur.set(rel, w)
    }
    return cur.size
  }

  private schedule(projectId: string, rel: string): void {
    if (this.closed) return
    const set = this.pending.get(projectId) ?? new Set<string>()
    set.add(rel)
    this.pending.set(projectId, set)
    if (this.timers.has(projectId)) return
    const t = setTimeout(() => {
      this.timers.delete(projectId)
      const dirs = [...(this.pending.get(projectId) ?? [])]
      this.pending.delete(projectId)
      if (dirs.length && !this.closed) this.onChange(projectId, dirs)
    }, this.flushMs)
    // 플러시 하나가 host 종료를 붙들면 안 된다
    t.unref?.()
    this.timers.set(projectId, t)
  }

  close(): void {
    this.closed = true
    for (const m of this.byProject.values()) for (const w of m.values()) w.close()
    this.byProject.clear()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.pending.clear()
  }
}
