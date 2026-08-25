import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirWatchers, MAX_WATCHED_DIRS } from './watch.js'

/**
 * 실제 파일시스템으로 검사한다 — 이 모듈의 계약은 "OS가 이벤트를 주면"이 아니라
 * "파일이 실제로 바뀌면"이다. fs.watch의 이벤트 모양은 플랫폼마다 다르고
 * (macOS는 rename 뭉뚱그림), 목으로 흉내 낸 이벤트는 그 차이를 못 잡는다.
 */

const dirs: string[] = []
const watchers: DirWatchers[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-watch-'))
  dirs.push(d)
  return d
}

function makeWatcher(onChange: (projectId: string, dirs: string[]) => void, flushMs = 80): DirWatchers {
  const w = new DirWatchers(onChange, flushMs)
  watchers.push(w)
  return w
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

afterEach(() => {
  for (const w of watchers.splice(0)) w.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('DirWatchers — 펼쳐진 디렉토리만 본다 (#34)', () => {
  /*
   * macOS의 fs.watch(FSEvents)는 스트림이 비동기로 서서, **감시 직후의 변화는 놓칠 수
   * 있다** (전체 스위트로 돌릴 때 실제로 놓쳤다 — 단독으로는 통과). 앱에서는 다음 변화가
   * 잡으므로 계약은 "언젠가는 알아챈다"이고, 테스트도 그 계약을 검사한다: 이벤트가 올
   * 때까지 거듭 쓴다. 한 번만 쓰고 기다리면 OS의 시동 지연이 테스트 실패로 둔갑한다.
   */
  it('밖에서 파일을 만들면 그 디렉토리가 알려온다', async () => {
    const root = tmp()
    mkdirSync(join(root, 'src'))
    const got: string[][] = []
    const w = makeWatcher((_p, d) => got.push(d))
    expect(w.setWatched('p1', root, ['', 'src'])).toBe(2)

    for (let i = 0; i < 30 && got.length === 0; i++) {
      writeFileSync(join(root, 'src', `new${i}.ts`), 'x')
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(got.flat()).toContain('src')
  })

  /*
   * 실측: 파일 500개 쓰기 36ms에 이벤트 501발. 이벤트마다 다시 읽으면 목록 요청
   * 500개다 — 이 검사가 지키는 계약은 "알림 수가 이벤트 수보다 훨씬 적다"이다.
   * "정확히 한 번"이 아니다: 버스트가 플러시 창(80ms)보다 길어지면 간격마다 한 번씩
   * 따라가는 것이 **설계**다 (npm install 내내 화면이 굶지 않는 이유). 전체 스위트의
   * 부하에서 100개 쓰기가 창을 넘겨 두 번이 된 적이 있다 — 그건 고장이 아니었다.
   */
  it('한 버스트(파일 100개)는 이벤트 수보다 훨씬 적은 알림으로 접힌다', async () => {
    const root = tmp()
    const got: string[][] = []
    const w = makeWatcher((_p, d) => got.push(d))
    w.setWatched('p1', root, [''])
    // FSEvents 시동 지연(위 주석)을 넘긴 뒤에 버스트를 쏜다 — 여기서 재는 것은 접힘이지 시동이 아니다
    await new Promise((r) => setTimeout(r, 300))

    for (let i = 0; i < 100; i++) writeFileSync(join(root, `f${i}.txt`), 'x')
    await until(() => got.length > 0)
    // 남은 플러시가 다 나올 시간을 주고 나서 센다
    await new Promise((r) => setTimeout(r, 300))
    expect(got.length).toBeLessThanOrEqual(4)
    expect(got.flat()).toContain('')
  })

  it('집합에서 뺀 디렉토리는 더 이상 알려오지 않는다 — 접으면 눈도 감는다', async () => {
    const root = tmp()
    mkdirSync(join(root, 'sub'))
    const got: string[][] = []
    const w = makeWatcher((_p, d) => got.push(d))
    w.setWatched('p1', root, ['sub'])
    expect(w.setWatched('p1', root, [])).toBe(0)

    writeFileSync(join(root, 'sub', 'after.txt'), 'x')
    await new Promise((r) => setTimeout(r, 300))
    expect(got).toEqual([])
  })

  it('감시 중이던 디렉토리가 지워지면 그 사실이 알려온다 — 화면이 걷을 수 있게', async () => {
    const root = tmp()
    mkdirSync(join(root, 'doomed'))
    const got: string[][] = []
    const w = makeWatcher((_p, d) => got.push(d))
    w.setWatched('p1', root, ['doomed'])
    await new Promise((r) => setTimeout(r, 300))

    rmSync(join(root, 'doomed'), { recursive: true })
    await until(() => got.flat().includes('doomed'))
    expect(got.flat()).toContain('doomed')
  })

  it('이미 사라진 디렉토리를 감시하라고 하면, 감시 대신 그 사실을 알린다', async () => {
    const root = tmp()
    const got: string[][] = []
    const w = makeWatcher((_p, d) => got.push(d))
    w.setWatched('p1', root, ['never-existed'])

    await until(() => got.length > 0)
    expect(got.flat()).toContain('never-existed')
  })

  it('프로젝트 밖 경로는 집합에 못 들어간다 — 트리의 다른 fs 경로와 같은 규칙', () => {
    const root = tmp()
    const w = makeWatcher(() => {})
    expect(w.setWatched('p1', root, ['../outside'])).toBe(0)
  })

  it('상한에 걸리면 지키는 수를 돌려준다 — 조용히 자르지 않는다', () => {
    const root = tmp()
    // 존재하지 않는 하위 경로 300개: watch는 실패해도 상한 판정이 먼저다
    for (let i = 0; i < 300; i++) mkdirSync(join(root, `d${i}`))
    const w = makeWatcher(() => {})
    const rels = Array.from({ length: 300 }, (_, i) => `d${i}`)
    expect(w.setWatched('p1', root, rels)).toBe(MAX_WATCHED_DIRS)
  })
})
