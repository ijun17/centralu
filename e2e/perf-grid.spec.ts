import { expect, test, type Page } from '@playwright/test'

/**
 * 그리드 성능 실측 (계획 7단계).
 *
 * 사양서 §5.4: "포커스 뷰 구조는 성능에도 유리 — 화면에 세션 하나만 렌더링하면 되므로
 * 그리드 대비 상시 렌더 부하가 낮다." 그 말이 맞는지, 맞다면 얼마나인지 잰다.
 *
 * 재는 것은 **프레임**이다. 총 소요 시간은 사람이 못 느끼지만 프레임이 밀리면 바로 느낀다.
 * 응답이 흐르는 동안 화면이 매끄러운가, 그리고 그때 글을 칠 수 있는가.
 */

test.describe.configure({ mode: 'serial' })

/*
 * 기본 e2e에는 끼지 않는다. 재는 값이 기계 상태를 타므로 문턱을 세우면 언젠가
 * 애먼 곳에서 빨개진다 — 여기서 나오는 건 판정이 아니라 **숫자**다.
 *   pnpm perf
 */
test.beforeEach(() => {
  test.skip(!process.env.PERF, 'PERF=1 일 때만 — `pnpm perf`')
})

type Result = {
  frames: number
  p50: number
  p95: number
  max: number
  janky: number
  heapMB: number | null
  /** 실제로 화면에 그려졌는가 — 이게 false면 위 숫자는 전부 무의미하다 */
  painted: boolean
  /** 마지막 항목이 얼마나 길어졌나 (글자) */
  grew: number
}

async function boot(page: Page, count: number): Promise<string[]> {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('first-run')).toBeVisible()
  await page.getByTestId('add-project').click()
  await page.getByTestId('project-path-input').fill('/tmp/alpha')
  await page.getByTestId('project-add-confirm').click()

  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('initial-prompt').fill(`session ${i}`)
    await page.getByTestId('create-session-confirm').click()
    await expect(page.getByTestId('new-session-dialog')).toBeHidden()
    ids.push(await page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId))
  }

  // 빈 세션은 현실이 아니다 — 각 세션에 200줄짜리 대화를 깔아둔다
  await page.evaluate((list: string[]) => {
    const store = (window as never as { __store: any }).__store
    const chat: Record<string, unknown[]> = {}
    for (const id of list) {
      chat[id] = Array.from({ length: 200 }, (_, i) => ({
        kind: i % 2 ? 'assistant' : 'user',
        seq: 1000 + i,
        text: `지난 대화 ${i} `.repeat(8),
      }))
    }
    store.setState({ chat })
  }, ids)

  return ids
}

/**
 * `streaming` 세션들에 매 프레임 델타를 흘리면서 프레임 간격을 잰다.
 * 실제 스트리밍과 같은 리듬 — 한 번에 몰아 넣으면 React가 배치해버려 측정이 거짓말이 된다.
 */
async function streamAndMeasure(page: Page, streaming: string[], frames: number): Promise<Result> {
  return page.evaluate(
    async ({ ids, n }: { ids: string[]; n: number }) => {
      const mock = (window as never as { __mock: any }).__mock
      const gaps: number[] = []
      let last = performance.now()

      await new Promise<void>((done) => {
        let i = 0
        const tick = () => {
          const now = performance.now()
          gaps.push(now - last)
          last = now
          for (const id of ids) {
            mock.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: `토큰${i} ` })
          }
          i++
          if (i < n) requestAnimationFrame(tick)
          else done()
        }
        requestAnimationFrame(tick)
      })

      /*
       * 측정이 거짓말이 아닌지 확인한다.
       * 화면이 실제로 안 바뀌었다면 프레임은 당연히 매끄럽다 —
       * 마지막 토큰이 DOM에 있는지 봐야 "그리면서도 매끄러웠다"가 된다.
       */
      const painted = document.body.innerText.includes(`토큰${n - 1}`)
      const store = (window as never as { __store: any }).__store
      const grew = (store.getState().chat[ids[0]!] ?? []).at(-1)?.text?.length ?? 0

      const sorted = [...gaps].sort((a, b) => a - b)
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      return {
        frames: gaps.length,
        p50: Math.round(at(0.5) * 10) / 10,
        p95: Math.round(at(0.95) * 10) / 10,
        max: Math.round(Math.max(...gaps) * 10) / 10,
        // 32ms를 넘으면 60fps 기준으로 프레임을 한 번 이상 건너뛴 것이다
        janky: gaps.filter((g) => g > 32).length,
        heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
        painted,
        grew,
      }
    },
    { ids: streaming, n: frames },
  )
}

const show = (label: string, r: Result) =>
  console.log(
    `${label.padEnd(34)} p50=${String(r.p50).padStart(5)}ms  p95=${String(r.p95).padStart(6)}ms  max=${String(r.max).padStart(6)}ms  건너뜀=${String(r.janky).padStart(3)}/${r.frames}  heap=${r.heapMB}MB  그려짐=${r.painted}  +${r.grew}자`,
  )

test('포커스 뷰 1개 (기준선)', async ({ page }) => {
  const ids = await boot(page, 1)
  await page.getByTestId(`session-row-${ids[0]}`).click()
  show('포커스 뷰 · 1개 스트리밍', await streamAndMeasure(page, ids, 120))
})

test('그리드 4칸 전부 스트리밍', async ({ page }) => {
  const ids = await boot(page, 4)
  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[3]}`)).toBeVisible()
  show('그리드 4칸 · 4개 스트리밍', await streamAndMeasure(page, ids, 120))
})

test('그리드 9칸 전부 스트리밍', async ({ page }) => {
  const ids = await boot(page, 9)
  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[8]}`)).toBeVisible()
  show('그리드 9칸 · 9개 스트리밍', await streamAndMeasure(page, ids, 120))
})

test('그리드 9칸인데 1개만 스트리밍 (§5.4의 상시 부하)', async ({ page }) => {
  const ids = await boot(page, 9)
  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[8]}`)).toBeVisible()
  show('그리드 9칸 · 1개만 스트리밍', await streamAndMeasure(page, [ids[0]!], 120))
})

test('9칸이 흐르는 동안 글을 칠 수 있는가', async ({ page }) => {
  const ids = await boot(page, 9)
  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[8]}`)).toBeVisible()

  // 배경에서 9개가 계속 흐르게 둔다
  await page.evaluate((l: string[]) => {
    const mock = (window as never as { __mock: any }).__mock
    const w = window as never as { __stop?: () => void }
    let on = true
    let i = 0
    const tick = () => {
      if (!on) return
      for (const id of l) mock.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: `토큰${i++} ` })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    w.__stop = () => (on = false)
  }, ids)

  const box = page.getByTestId(`grid-panel-${ids[0]}`).getByTestId('prompt-input')
  await box.click()
  const t0 = Date.now()
  await box.pressSequentially('타자 지연 측정', { delay: 0 })
  const typed = Date.now() - t0
  const value = await box.inputValue()

  await page.evaluate(() => (window as never as { __stop?: () => void }).__stop?.())
  console.log(`타자: 8글자에 ${typed}ms (글자당 ${Math.round(typed / 8)}ms), 값="${value}"`)
  expect(value).toBe('타자 지연 측정')
})

/**
 * 칸을 처음 여는 순간.
 *
 * 칸마다 스스로 기록을 불러오게 만들었으므로, 9칸을 한 번에 열면 로드도 9번이다.
 * 그 순간이 얼마나 걸리는지 — 여기가 이번 변경으로 판돈이 커진 자리다.
 */
test('9칸을 처음 여는 데 걸리는 시간', async ({ page }) => {
  const ids = await boot(page, 9)

  // 저장소에는 기록이 있고 화면에는 아무것도 안 올라온 상태 (앱을 막 켠 직후)
  await page.evaluate((list: string[]) => {
    const mock = (window as never as { __mock: any }).__mock
    for (const id of list) {
      mock.messages.set(
        id,
        Array.from({ length: 200 }, (_, i) => ({
          sessionId: id, seq: i + 1, role: i % 2 ? 'assistant' : 'user',
          kind: 'text', payload: { text: `저장된 대화 ${i} `.repeat(8) }, ts: 0,
        })),
      )
    }
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: {} })
    store.getState().setGridPanels(list)
  }, ids)

  const t0 = Date.now()
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[8]}`)).toContainText('저장된 대화')
  const opened = Date.now() - t0

  const loadedCount = await page.evaluate(
    (list: string[]) => list.filter((id) => (window as never as { __store: any }).__store.getState().chat[id]?.length).length,
    ids,
  )
  console.log(`9칸 처음 열기: ${opened}ms, 대화가 채워진 칸 ${loadedCount}/9`)
  expect(loadedCount).toBe(9)
})

/**
 * 대화가 길어지면 느려지는가 — "위쪽을 UI에서 지우면 좋아지나"에 대한 답.
 *
 * 이미 세 겹으로 자르고 있다: 비포커스 세션은 50개로 잘리고(WINDOW_SIZE),
 * 기록은 200개씩 창으로 읽고, 가상 스크롤이 보이는 줄만 그린다.
 * 그래도 **목록 길이 자체가** 부담인지는 재봐야 안다.
 */
for (const n of [200, 5000]) {
  test(`대화 ${n}줄에서 스트리밍`, async ({ page }) => {
    const ids = await boot(page, 1)
    await page.evaluate(
      ({ sid, count }: { sid: string; count: number }) => {
        const store = (window as never as { __store: any }).__store
        const items = Array.from({ length: count }, (_, i) => ({
          kind: i % 2 ? 'assistant' : 'user', seq: 1000 + i, text: `지난 대화 ${i} `.repeat(8),
        }))
        store.setState({ chat: { ...store.getState().chat, [sid]: items } })
      },
      { sid: ids[0]!, count: n },
    )
    await page.getByTestId(`session-row-${ids[0]}`).click()
    show(`포커스 뷰 · 대화 ${n}줄`, await streamAndMeasure(page, ids, 120))
  })
}
