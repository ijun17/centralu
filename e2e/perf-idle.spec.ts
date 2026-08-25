import { execSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

/**
 * 상시 렌더 부하 실측 (도그푸딩: "배터리가 쭉쭉 단다").
 *
 * 스트리밍이 아니라 **아무것도 안 할 때**를 잰다. 응답이 흐르는 동안 비싼 것은
 * 일이 비싼 것이지만, 가만히 있는데 비싸면 그건 전부 낭비다 — 노트북에서는
 * 그 낭비가 배터리로 청구된다.
 *
 * 세 개를 함께 본다:
 *  - React 커밋 수: 상태가 조용한데 커밋이 돈다면 어딘가 타이머가 있다
 *  - 구동 중 애니메이션 수: CSS 무한 애니메이션은 커밋 없이도 화면을 계속 그린다
 *  - 브라우저 프로세스 CPU 합: 위 둘이 실제로 얼마를 청구하는가 (top 실측)
 *
 * WebKit으로 잰다 — 실물은 WKWebView다. 특히 cc-orbit은 등록된 CSS 변수로
 * conic-gradient 각도를 돌리는데, 이는 컴포지터로 못 빠지고 매 프레임 메인
 * 스레드 리페인트를 일으킨다는 혐의가 있다. 여기 숫자가 그 판결문이다.
 *
 * 문턱은 세우지 않는다 (perf-grid와 같은 이유) — 여기서 나오는 건 **숫자**다.
 *   pnpm perf
 */

test.use({ browserName: 'webkit' })
test.describe.configure({ mode: 'serial' })

test.beforeEach(() => {
  test.skip(!process.env.PERF, 'PERF=1 일 때만 — `pnpm perf`')
})

/** ms-playwright의 WebKit 프로세스 일체 (UIProcess·WebContent·GPU·Networking) */
function webkitPids(): number[] {
  const out = execSync('ps -Ao pid,command').toString()
  return out
    .split('\n')
    .filter((l) => l.includes('ms-playwright') && /[Ww]eb[Kk]it|Playwright/.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isFinite(n))
}

/**
 * top으로 구간 CPU를 잰다. 첫 샘플은 부팅 이후 누적이라 버린다.
 * ps의 %cpu는 감쇠 평균이라 시나리오 전환을 못 따라간다 — top의 구간 값을 쓴다.
 */
function cpuOver(seconds: number, pids: number[]): number {
  const out = execSync(`top -l ${seconds + 1} -s 1 -stats pid,cpu,command`, {
    maxBuffer: 32 * 1024 * 1024,
  }).toString()
  const blocks = out.split(/Processes:/).slice(2) // 첫 블록(누적)을 버린다
  const wanted = new Set(pids)
  let total = 0
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+(?:\.\d+)?)/)
      if (m && wanted.has(Number(m[1]))) total += Number(m[2])
    }
  }
  return blocks.length ? total / blocks.length : 0
}

type Sample = { commits: number; perSec: number; animations: number; cpu: number }

/** 구간 동안 커밋을 세고, 같은 구간의 CPU를 밖에서 잰다 */
async function measure(page: Page, seconds: number): Promise<Sample> {
  const pids = webkitPids()
  await page.evaluate(() => {
    ;(window as never as { __commits: number }).__commits = 0
  })
  // CPU 측정(동기)이 도는 동안 페이지는 제 할 일을 한다
  const cpu = cpuOver(seconds, pids)
  const { commits, animations } = await page.evaluate(() => ({
    commits: (window as never as { __commits: number }).__commits,
    animations: document.getAnimations().length,
  }))
  return { commits, perSec: Math.round((commits / seconds) * 10) / 10, animations, cpu: Math.round(cpu * 10) / 10 }
}

const show = (label: string, s: Sample) =>
  console.log(
    `${label.padEnd(34)} commits=${String(s.commits).padStart(4)} (${String(s.perSec).padStart(5)}/s)  anims=${String(s.animations).padStart(2)}  cpu=${String(s.cpu).padStart(6)}%`,
  )

async function boot(page: Page, count: number): Promise<string[]> {
  // React보다 먼저 갈고리를 걸어야 커밋이 보인다
  await page.addInitScript(() => {
    const w = window as never as { __commits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }
    w.__commits = 0
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      isDisabled: false,
      supportsFiber: true,
      supportsFlight: false,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => {},
      sub: () => {},
      on: () => {},
      off: () => {},
      emit: () => {},
      onScheduleFiberRoot: () => {},
      onCommitFiberRoot: () => {
        w.__commits += 1
      },
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      setStrictMode: () => {},
    }
  })

  await page.goto('/?mock=1')
  await expect(page.getByTestId('first-run')).toBeVisible()
  await page.evaluate(() => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('first-run-pick').click()
  await expect(page.getByTestId('project-alpha')).toBeVisible()

  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('initial-prompt').fill(`session ${i}`)
    await page.getByTestId('create-session-confirm').click()
    await expect(page.getByTestId('new-session-dialog')).toBeHidden()
    ids.push(await page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId))
  }
  return ids
}

/** 상태 전환은 실제 경로(이벤트)로 — 화면이 실제로 겪는 것과 같은 흐름이다 */
async function setStates(page: Page, ids: string[], state: 'idle' | 'working') {
  await page.evaluate(
    ({ list, s }: { list: string[]; s: string }) => {
      const mock = (window as never as { __mock: any }).__mock
      for (const id of list) mock.emit({ type: 'state_change', sessionId: id, state: s })
    },
    { list: ids, s: state },
  )
}

test('가만히 있을 때 화면은 얼마를 쓰는가', async ({ page }) => {
  test.setTimeout(120000)
  const ids = await boot(page, 4)

  // 만들자마자 working이 된다(초기 프롬프트) — 조용한 기준선부터
  await setStates(page, ids, 'idle')
  await page.waitForTimeout(500)
  show('포커스 뷰 · 4개 전부 쉼', await measure(page, 8))

  await setStates(page, ids, 'working')
  await page.waitForTimeout(500)
  show('포커스 뷰 · 4개 전부 작업 중', await measure(page, 8))

  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[3]}`)).toBeVisible()
  await page.waitForTimeout(500)
  show('그리드 4칸 · 4개 전부 작업 중', await measure(page, 8))

  // 애니메이션만 끄면 얼마가 남는가 — 남는 것이 타이머·리렌더의 몫이다
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important }' })
  await page.waitForTimeout(500)
  show('그리드 4칸 · 작업 중 · 애니메이션 끔', await measure(page, 8))

  await setStates(page, ids, 'idle')
  await page.waitForTimeout(500)
  show('그리드 4칸 · 4개 전부 쉼', await measure(page, 8))
})
