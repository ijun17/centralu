import { expect, test, type Page } from '@playwright/test'

/**
 * 응답 중인 칸의 테두리는 창 폭이 무엇이든 **네 변이 다 보인다** (#208).
 *
 * 창 폭에 따라 칸의 폭과 자리가 소수점 픽셀이 되고, 그런 칸에서 링의 한 변이 사라졌다.
 * 폭을 1px씩 훑어 잰 결과 (칸 3·4·6·9개, 1·2배율, 글자 배율 1·1.1):
 *  - Chromium은 한 번도 흐려지지 않았다.
 *  - WebKit 1배율에서는 세 열 그리드의 가운데 열 칸이 x.328에서 시작하는 폭마다 — 창 폭
 *    세 번에 한 번(1401, 1404, …, 1500, 1701, …) — **오른쪽 변이 통째로 사라졌다.** 흐려진
 *    것이 아니라 0이다: 그 자리에 칸의 회색 테두리와 칸 바닥만 남았다. 회전하는 무지개도,
 *    멈춘 회색도 같은 자리에서 끊겼다 (둘 다 같은 마스크를 쓰기 때문이다).
 * 그래서 WebKit으로 잰다 — 실물도 WKWebView다 (perf-idle.spec.ts와 같은 이유).
 *
 * 값이 아니라 **픽셀**을 본다. 칸의 클래스나 z 값은 링이 거기 있어야 한다고 말할 뿐,
 * 마스크가 그 픽셀을 남겼는지는 화면만 안다.
 */
test.use({ browserName: 'webkit', deviceScaleFactor: 1 })

/**
 * 잴 창 폭. 앞의 넷은 이슈가 고른 흔한 폭(두 열), 뒤의 넷은 WebKit에서 실제로 오른쪽 변이
 * 사라지던 폭(세 열)이다.
 */
const WIDTHS = [1280, 1281, 1333, 1366, 1401, 1404, 1437, 1500]

/** --color-ash. 멈춘 링의 색이고, 아래 시험은 도는 링의 판도 이 색으로 칠해 모양만 본다 */
const ASH = 144
/**
 * 켜진 변의 문턱. 링이 사라진 변은 칸의 테두리(graphite 53)나 바닥(void 29)만 읽히고,
 * 반 픽셀로 흐려진 변은 그 사이(~86)에 선다. 켜진 변은 ASH 그대로다.
 */
const LIT = ASH - 8

const EDGES = ['top', 'right', 'bottom', 'left'] as const
type Dim = { width: number; panel: number; edge: (typeof EDGES)[number]; peak: number }

async function setup(page: Page, path = '/tmp/alpha') {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, path)
  await page.getByTestId('orchestrator-pick-folder').click()
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
}

async function newSession(page: Page, prompt: string): Promise<string> {
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('tool-option-claude').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
  return page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId)
}

/** 응답 중인 칸 셋을 그리드에 세운다 — 1400px부터 세 열이 된다 */
async function workingGrid(page: Page): Promise<string[]> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await setup(page)
  const ids = [await newSession(page, '하나'), await newSession(page, '둘'), await newSession(page, '셋')]
  await page.evaluate((l: string[]) => {
    const store = (window as never as { __store: any }).__store
    store.getState().setGridPanels(l)
    store.setState((s: any) => {
      const sessions = { ...s.sessions }
      for (const id of l) sessions[id] = { ...sessions[id], state: 'working' }
      return { sessions }
    })
  }, ids)
  await page.getByTestId('grid-button').click()
  for (const id of ids) await expect(page.getByTestId(`grid-panel-${id}`)).toHaveClass(/cc-orbit-ring/)
  // 입력칸이 잡혀 있으면 입력창이 떠올라 아랫변 근처를 채운다 — 손을 떼고 칸 밖에 둔다
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(1, 1)
  return ids
}

/**
 * 칸마다 네 변의 **가장 어두운 곳**을 잰다.
 *
 * 변을 따라 한 줄씩(둥근 모서리 12px은 뺀다) 칸 바깥 1px부터 안쪽 3px까지 네 픽셀 중
 * 가장 밝은 값을 고른다 — 링이 테두리 자리에 있든 그 안쪽 한 픽셀에 있든 잡힌다. 그 값들
 * 중 가장 작은 것이 그 변의 값이다: 변의 어느 한 토막이라도 끊기면 여기서 드러난다.
 */
async function edgePeaks(page: Page, ids: string[]) {
  const boxes = await page.evaluate(
    (l: string[]) =>
      l.map((id) => {
        const r = document.querySelector(`[data-testid="grid-panel-${id}"]`)!.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      }),
    ids,
  )
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  const peaks = await page.evaluate(
    async ([b64, bs]: [string, typeof boxes]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const g = canvas.getContext('2d')!
      g.drawImage(img, 0, 0)
      const px = g.getImageData(0, 0, img.width, img.height).data
      const at = (x: number, y: number) => {
        const i = (y * img.width + x) * 4
        return Math.max(px[i]!, px[i + 1]!, px[i + 2]!)
      }
      const CORNER = 12
      /** outer: 칸 바깥 첫 픽셀, dir: 안쪽 방향, along: 변을 따라가는 범위 */
      const edge = (outer: number, dir: 1 | -1, from: number, to: number, horizontal: boolean) => {
        let low = 255
        for (let p = Math.ceil(from) + CORNER; p < Math.floor(to) - CORNER; p++) {
          let high = 0
          for (let k = 0; k < 4; k++) {
            const q = outer + dir * k
            high = Math.max(high, horizontal ? at(p, q) : at(q, p))
          }
          low = Math.min(low, high)
        }
        return low
      }
      return bs.map((b) => ({
        top: edge(Math.floor(b.top) - 1, 1, b.left, b.right, true),
        bottom: edge(Math.ceil(b.bottom), -1, b.left, b.right, true),
        left: edge(Math.floor(b.left) - 1, 1, b.top, b.bottom, false),
        right: edge(Math.ceil(b.right), -1, b.top, b.bottom, false),
      }))
    },
    [png.toString('base64'), boxes] as [string, typeof boxes],
  )
  return { boxes, peaks }
}

/**
 * 격자가 제자리를 잡을 때까지 기다린다. 폭이 바뀌면 ResizeObserver가 열 수를 다시 고르고
 * React가 다시 그린다 — 그 사이에 찍으면 도중의 격자를 사실로 적는다. 칸들의 자리가 두 프레임
 * 연속 같을 때까지 본다.
 */
async function settle(page: Page) {
  await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    const read = () =>
      JSON.stringify(
        [...document.querySelectorAll('[data-testid^="grid-panel-"]')].map((el) => {
          const r = el.getBoundingClientRect()
          return [r.left, r.top, r.width, r.height]
        }),
      )
    let last = ''
    for (let i = 0; i < 30; i++) {
      await frame()
      await frame()
      const now = read()
      if (now === last) return
      last = now
    }
  })
}

/** 창 폭마다 네 변을 재서 켜지지 않은 변만 모은다 — 실패하면 어느 폭·칸·변인지가 곧 메시지다 */
async function dimEdges(page: Page, ids: string[], before?: () => Promise<void>) {
  const dim: Dim[] = []
  const boxes: { width: number; left: number; top: number; right: number; bottom: number }[] = []
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 })
    await settle(page)
    if (before) {
      await before()
      await settle(page)
    }
    const m = await edgePeaks(page, ids)
    m.peaks.forEach((p, panel) => {
      for (const edge of EDGES) if (p[edge] < LIT) dim.push({ width, panel, edge, peak: p[edge] })
    })
    for (const b of m.boxes) boxes.push({ width, ...b })
  }
  return { dim, boxes }
}

/** 칸의 네 모서리 중 하나라도 픽셀 사이에 서 있는가 */
const offPixel = (b: { left: number; top: number; right: number; bottom: number }) =>
  [b.left, b.top, b.right, b.bottom].some((v) => v % 1 !== 0)

test('멈춘 링(회색)은 창 폭이 무엇이든 칸의 네 변에 다 보인다 — 칸이 소수점 픽셀에 서도', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const ids = await workingGrid(page)
  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setSpinGrid(false))
  await expect(page.locator('html')).toHaveAttribute('data-spin-grid', 'off')

  // 그리드가 세우는 그대로
  expect((await dimEdges(page, ids)).dim).toEqual([])

  /*
   * 그리고 칸을 **일부러 소수점 픽셀에** 세워서도 본다. 그리드는 이제 칸을 정수 픽셀에
   * 세우지만(GridView의 wholePixelTracks), 글자 배율을 바꾸면 한 CSS 픽셀이 화면 픽셀과
   * 어긋나 칸은 다시 소수점에 선다. 멈춘 링은 칸의 테두리이므로 자리에 기대지 않아야 한다 —
   * 그래서 예전의 1fr 격자를 덧씌워 칸을 옛 자리(x.328)로 돌려놓고 같은 것을 잰다.
   */
  const evenTracks = async () => {
    await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="grid"] > .grid') as HTMLElement
      const n = (v: string) => v.trim().split(/\s+/).length
      // 예전 격자는 각 칸에 1fr을 줬다 — 열·줄 수는 지금 그리드가 고른 것을 그대로 쓴다
      const cols = n(getComputedStyle(grid).gridTemplateColumns)
      const rows = n(getComputedStyle(grid).gridTemplateRows)
      let tag = document.getElementById('even-tracks')
      if (!tag) {
        tag = document.createElement('style')
        tag.id = 'even-tracks'
        document.head.append(tag)
      }
      tag.textContent = `[data-testid="grid"] > .grid {
        grid-template-columns: repeat(${cols}, minmax(0, 1fr)) !important;
        grid-template-rows: repeat(${rows}, minmax(0, 1fr)) !important;
      }`
    })
  }
  // 덧씌운 격자는 폭마다 새로 쓴다 — 열 수는 폭을 따라 바뀌고, 그건 그리드가 고른 값이어야 한다
  const forced = await dimEdges(page, ids, async () => {
    await page.evaluate(() => document.getElementById('even-tracks')?.remove())
    await settle(page)
    await evenTracks()
  })
  // 덧씌우기가 정말 칸을 소수점에 세웠는지 — 아니면 이 절반은 아무것도 재지 않은 것이다
  expect(forced.boxes.some(offPixel)).toBe(true)
  expect(forced.dim).toEqual([])
})

test('도는 링(무지개)의 모양은 창 폭이 무엇이든 네 변을 다 남긴다 — 칸이 온전한 픽셀에 선다', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const ids = await workingGrid(page)
  /*
   * 도는 판의 색은 각도마다 다르고 한 조각(300°–360°)은 투명하다. 그대로 찍으면 "끊겼다"와
   * "지금 그 각도가 투명하다"를 가를 수 없다. 그래서 판만 **한 색으로 칠하고 세운다** —
   * 링의 모양(마스크)은 그대로 두고, 그 마스크가 어느 픽셀을 남기는지만 본다.
   */
  await page.addStyleTag({
    content: `.cc-orbit-ring-layer::before { animation: none !important; background: rgb(${ASH}, ${ASH}, ${ASH}) !important; }`,
  })

  const { dim, boxes } = await dimEdges(page, ids)
  expect(dim).toEqual([])
  // 그리고 그 까닭: 칸은 온전한 픽셀에 선다 — 이 마스크가 네 변을 남기는 조건이다
  expect(boxes.filter(offPixel)).toEqual([])
})
