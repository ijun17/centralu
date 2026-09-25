import { execFileSync } from 'node:child_process'

/**
 * 프로세스 **트리**를 죽인다 — 명령 실행기, 터미널 탭, 앱 프로세스(M4)가 함께 쓴다.
 *
 * node-pty의 `kill()`은 pty 자식 pid **하나**에만 시그널을 보낸다. 그런데 우리가 띄우는
 * 건 언제나 셸이고, 데브 서버는 그 아래에 있다. 셸만 맞고 서버는 살아남아 포트를 물고
 * 있는 일이 실제로 있었다 (도그푸딩 2026-09-07).
 *
 * 그룹(-pid) 하나로 끝나지 않는 이유 (실측 2026-09-07):
 *
 *   - `zsh -lc <command>` (명령 실행기)는 **비대화형**이라 잡 컨트롤이 없다. 자식들은
 *     셸과 같은 프로세스 그룹에 남으므로 `kill(-pid)` 한 방이면 트리 전체가 맞는다.
 *   - `zsh -l` (터미널 탭)은 **대화형**이라 잡 컨트롤이 켜진다. 거기서 띄운 데브 서버는
 *     **자기 프로세스 그룹**을 갖는다 — 셸의 그룹을 쏴도 서버는 안 맞는다. SIGHUP을
 *     스스로 다루는 서버(흔하다)라면 셸이 죽어도 그대로 남아 고아가 된다.
 *
 * 그래서 ps로 자손을 훑어 **그들이 속한 그룹 전부**를 과녁으로 삼는다. 한 번의 ps는
 * 10ms 남짓이고, 이 함수는 Stop을 누를 때와 앱을 끌 때만 불린다.
 *
 * 유예 뒤의 두 번째 발(SIGKILL)은 **첫 발 때 본 트리**를 명단으로 들고 가서, 그중 아직
 * 남은 것을 쏜다 (#149). root(셸이나 앱)는 SIGTERM에 먼저 죽고, 그 아래에서 trap을 건
 * 데브 서버가 버티는 일이 흔하다. root가 죽으면 자손은 init(launchd)에 입양되어 ps에서
 * 더는 root 아래에 없다 — 두 번째 발을 root가 살아 있는지로 정하거나 root에서 다시
 * 훑으면, 버틴 자손이 과녁에서 빠진 채 고아로 남는다 (재현: 손자가 ppid 1로 살아 있었다).
 *
 * 닿지 않는 자리도 있다: 첫 발보다 **먼저** 트리를 떠난 것(setsid 뒤 부모를 끊고 데몬이
 * 된 서버)은 ps로 root에서 찾을 수 없다. 셸을 포함해 어떤 프로세스 관리자도 마찬가지다.
 *
 * 자기 자신(호스트)이 속한 그룹은 절대 쏘지 않는다 — 정리하다 자기를 죽이면 남은
 * 프로세스를 아무도 못 치운다.
 */

/** SIGTERM 뒤 이만큼 안 죽으면 SIGKILL — trap을 걸어 둔 데브 서버가 버티는 것까지 책임진다 */
export const KILL_GRACE_MS = 3000

export type KillablePty = {
  /** node-pty가 준 자식 pid. 페이크·win32에는 없다 */
  pid?: number
  kill(signal?: string): void
}

export type ProcRow = { pid: number; ppid: number; pgid: number }

/** `ps -A -o pid=,ppid=,pgid=` 출력 → 행들. 못 읽은 줄은 조용히 버린다 */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) })
  }
  return rows
}

/** roots와, ppid를 따라 내려간 그 자손 전부 */
function descend(rows: ProcRow[], roots: readonly number[]): Set<number> {
  const byParent = new Map<number, number[]>()
  for (const r of rows) {
    const kids = byParent.get(r.ppid)
    if (kids) kids.push(r.pid)
    else byParent.set(r.ppid, [r.pid])
  }
  const seen = new Set<number>(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.shift()!
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      queue.push(kid)
    }
  }
  return seen
}

/** pids가 속한 그룹들. 두 발이 같은 규칙을 쓴다 — 우리 그룹과 init(1)·0은 과녁이 아니다 */
function groupsOf(pids: Iterable<number>, pgidOf: ReadonlyMap<number, number>, self: number): number[] {
  const selfPgid = pgidOf.get(self)
  const groups: number[] = []
  for (const pid of pids) {
    const g = pgidOf.get(pid)
    if (g === undefined || g <= 1) continue
    if (g === selfPgid) continue // 우리 자신 — 여기서 죽으면 정리가 중간에 끊긴다
    if (!groups.includes(g)) groups.push(g)
  }
  return groups
}

/**
 * 쏠 프로세스 그룹들 (음수로 보낼 pgid). root 자신의 그룹이 언제나 첫 과녁이다.
 *
 * `self`(호스트)가 속한 그룹은 뺀다. ps를 못 읽었으면 rows가 비고, 그러면 답은
 * root의 그룹 하나 — 예전 동작 그대로다.
 */
export function killTargets(rows: ProcRow[], root: number, self: number): number[] {
  const pgidOf = new Map<number, number>()
  for (const r of rows) pgidOf.set(r.pid, r.pgid)

  /*
   * ps는 읽혔는데 root가 그 안에 없다 = 이미 죽었다. 그럴 땐 **아무것도 쏘지 않는다.**
   * root의 그룹을 짐작해 쏘는 폴백은 ps 자체를 못 읽었을 때의 이야기고, 여기서 그러면
   * 유예 뒤의 두 번째 발이 **재사용된 pid의 남의 그룹**을 때릴 수 있다.
   */
  if (rows.length > 0 && !pgidOf.has(root)) return []
  if (rows.length === 0) pgidOf.set(root, root) // 그 폴백 — pty의 셸도 앱 프로세스도 자기 그룹의 우두머리로 뜬다

  return groupsOf(descend(rows, [root]), pgidOf, self)
}

/**
 * 두 번째 발의 과녁 (#149). 첫 발 때 본 트리(`first`) 중 **아직 같은 그룹에 남은 것**과, 그들이
 * 유예 사이에 새로 띄운 자손이 속한 그룹 전부. root에서 다시 훑지 않는다 — root가 먼저 죽었으면
 * 버틴 자손은 init에 입양되어 root 아래에 없다 (머리말).
 *
 * 같은 pid가 같은 그룹에 있으면 같은 프로세스로 본다. 그새 사라진 것은 쏘지 않는다 — 그 번호는
 * 남에게 갔을 수 있다(killTargets의 "이미 죽었다"와 같은 까닭). 남은 것이 하나라도 있는 그룹은
 * 그룹째 쏜다: 그룹에 누가 남아 있는 동안 그 번호는 재사용되지 않는다.
 */
export function survivorTargets(rows: ProcRow[], first: readonly ProcRow[], self: number): number[] {
  const pgidOf = new Map<number, number>()
  for (const r of rows) pgidOf.set(r.pid, r.pgid)
  const survivors = first.filter((f) => pgidOf.get(f.pid) === f.pgid).map((f) => f.pid)
  return groupsOf(descend(rows, survivors), pgidOf, self)
}

/** ps 한 장. 실패하면 빈 배열 — 그러면 root의 그룹만 쏘는 예전 동작으로 내려앉는다 */
function snapshot(): ProcRow[] {
  try {
    return parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2000 }))
  } catch {
    return []
  }
}

/** 트리에 시그널 한 발 쏘고, 그때 본 트리(root와 자손의 행)를 돌려준다 — 두 번째 발이 들고 갈 명단이다 */
function shoot(handle: KillablePty, signal: 'SIGTERM' | 'SIGKILL'): ProcRow[] {
  const pid = handle.pid
  if (process.platform === 'win32' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    try {
      handle.kill(signal)
    } catch {
      // 이미 죽었다
    }
    return []
  }

  const rows = snapshot()
  let hit = false
  for (const g of killTargets(rows, pid, process.pid)) {
    try {
      process.kill(-g, signal)
      hit = true
    } catch {
      // 그 그룹은 이미 사라졌다 — 나머지는 계속 쏜다
    }
  }
  if (!hit) {
    try {
      handle.kill(signal) // 그룹이 전부 사라졌거나 권한이 없다 — 마지막 확인 사살
    } catch {
      // 이미 죽었다
    }
  }
  if (!rows.some((r) => r.pid === pid)) return [] // ps를 못 읽었거나 root가 이미 없었다 — 명단이 없다
  const tree = descend(rows, [pid])
  return rows.filter((r) => tree.has(r.pid))
}

/** 트리에 시그널 한 발. pid를 모르면(페이크·win32) 종전처럼 pty.kill로 물러난다 */
export function killTree(handle: KillablePty, signal: 'SIGTERM' | 'SIGKILL'): void {
  shoot(handle, signal)
}

/**
 * SIGTERM으로 정중히, 유예 안에 안 죽으면 SIGKILL — 첫 발 때 본 트리에서 아직 남은 것에 (#149).
 *
 * 두 번째 발을 쏠지는 root가 살아 있는지로 정하지 않는다. `alive`는 root **자신**에 대한 호출자의
 * 앎이다: false면 호출자가 root의 끝남을 이미 봤다(거둬졌다)는 뜻이고, 그 번호로 지금 보이는 것은
 * 남일 수 있으니 root만 명단에서 뺀다. 남은 자손은 그와 상관없이 맞는다.
 */
export function stopTree(handle: KillablePty, graceMs: number, alive: () => boolean): void {
  const first = shoot(handle, 'SIGTERM')
  const t = setTimeout(() => finish(handle, first, alive()), graceMs)
  t.unref?.()
}

/**
 * 우두머리가 **이미 스스로 끝난** 그룹을 거둔다 — 두 발, stopTree와 같은 규칙으로.
 *
 * stopTree는 root에서 트리를 훑는다. 그런데 root가 먼저 끝났으면 ps에 root가 없어 과녁이 비고(killTargets의 "이미
 * 죽었다"), 그 자손은 init에 입양되어 root 아래에도 없다 — 스스로 잘 끝난 앱(M4 A-3)이 남긴 도우미가 바로 그 자리다.
 * 그래서 그룹 번호로 찾는다: 앱은 자기 그룹의 우두머리로 뜨고(detached), 그룹에 누가 남아 있는 동안 그 번호는 pid로
 * 재사용되지 않는다(POSIX) — 그룹째 쏘아도 남의 프로세스에 닿지 않는다.
 *
 * 첫 발(SIGTERM) 때의 그룹 명단을 들고 가서, 유예 뒤 **아직 남은 것**과 그들이 새로 띄운 자손에 SIGKILL을 쏜다(survivorTargets).
 * SIGTERM을 무시하는 도우미가 launchd 아래 고아로 남던 자리다. ps를 못 읽으면 예전처럼 그룹째 쏜다.
 */
export function stopGroup(pgid: number, graceMs: number): void {
  if (process.platform === 'win32' || !Number.isInteger(pgid) || pgid <= 1) return
  const rows = snapshot()
  const members = rows.filter((r) => r.pgid === pgid)
  if (rows.length > 0 && members.length === 0) return // 그룹이 비었다 — 흔한 경우다
  if (members.some((r) => r.pid === process.pid)) return // 우리 그룹 — 여기서 죽으면 정리가 끊긴다
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {
    return // 그 사이에 비었다
  }
  const t = setTimeout(() => {
    const now = snapshot()
    const targets = now.length > 0 ? survivorTargets(now, members, process.pid) : [pgid]
    for (const g of targets) {
      try {
        process.kill(-g, 'SIGKILL')
      } catch {
        // 그 그룹은 그새 비었다 — 나머지는 계속 쏜다
      }
    }
  }, graceMs)
  t.unref?.()
}

/** stopTree의 두 번째 발 */
function finish(handle: KillablePty, first: ProcRow[], rootOurs: boolean): void {
  /*
   * 명단이 없다 — pid를 모르거나(페이크·win32), ps를 못 읽었거나, root가 첫 발 때 이미 없었다.
   * 누가 트리였는지 모르니 예전 동작 그대로: root가 아직 우리 것일 때만 root에서 다시 쏜다.
   */
  const rows = first.length > 0 ? snapshot() : []
  if (rows.length === 0) {
    if (rootOurs) killTree(handle, 'SIGKILL')
    return
  }

  const known = rootOurs ? first : first.filter((r) => r.pid !== handle.pid)
  let hit = false
  for (const g of survivorTargets(rows, known, process.pid)) {
    try {
      process.kill(-g, 'SIGKILL')
      hit = true
    } catch {
      // 그 그룹은 그새 비었다 — 나머지는 계속 쏜다
    }
  }
  /*
   * 그룹으로는 하나도 못 맞혔는데 root가 아직 표에 있다 — root가 우리 그룹에 있어 그룹째 쏠 수 없는
   * 자리다. pid 하나로 확인 사살한다. 표에 없으면 이미 끝났다: 끝난 번호에는 쏘지 않는다.
   */
  if (hit || !rootOurs || !rows.some((r) => r.pid === handle.pid)) return
  try {
    handle.kill('SIGKILL')
  } catch {
    // 이미 죽었다
  }
}
