import { expect, test, type Page } from '@playwright/test'

/**
 * 입력 지연 실측 (도그푸딩: "입력창이 좀 버벅거린다").
 *
 * 재는 것은 **글자 하나에 드는 일**이다: input 이벤트를 넣은 순간부터 React가
 * 렌더·커밋·레이아웃을 끝내고 dispatch가 돌아올 때까지.
 *
 * 대화 길이를 바꿔가며 잰다. 초안(draft)이 전역 스토어에 있어서 한 글자마다 세션
 * 화면 전체가 다시 그려진다면, 이 숫자는 **대화가 길어질수록 커진다** — 입력창의
 * 비용이 대화의 크기에 비례할 이유는 없으므로, 그 기울기 자체가 증거다.
 *
 * 이 하네스가 처음 답한 것은 시간이 아니라 **누가 다시 그려지는가**였다. 임시로
 * 렌더 계수기를 심어 재니 글자 하나마다:
 *   before  pane=1.0  stream=1.0  row=2.0   (답변 흐르는 중 pane=2.0 row=4.5)
 *   after   composer=1.0, 나머지 0           (답변 흐르는 중에도 composer=1.0)
 * 시간(p50 1~2ms)은 이 화면 크기·이 마크다운 양에서 잰 값이라 상한이 아니다 —
 * 줄인 것은 "대화가 커지면 같이 커지던 비용"이다.
 *
 * 문턱은 세우지 않는다 (perf-idle과 같은 이유) — 여기서 나오는 건 숫자다.
 *   PERF=1 pnpm e2e perf-typing --workers=1
 *
 * WebKit으로 잰다 — 실물은 WKWebView다.
 */
test.use({ browserName: 'webkit' })
test.describe.configure({ mode: 'serial' })

test.beforeEach(() => {
  test.skip(!process.env.PERF, 'PERF=1 일 때만')
})

type Sample = { p50: number; p95: number; max: number; commits: number; keys: number }

const show = (label: string, s: Sample) =>
  console.log(
    `${label.padEnd(30)} p50=${s.p50.toFixed(2)}ms  p95=${s.p95.toFixed(2)}ms  max=${s.max.toFixed(2)}ms  commits/key=${(s.commits / s.keys).toFixed(1)}`,
  )

async function boot(page: Page): Promise<string> {
  // React보다 먼저 갈고리를 걸어야 커밋이 보인다 (perf-idle과 같은 방식)
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
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate(() => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('orchestrator-pick-folder').click()
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-alpha')).toBeVisible()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('prompt-input').fill('start')
  await page.getByTestId('prompt-input').press('Enter')
  return page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId)
}

/**
 * 대화를 채운다.
 *
 * 한 턴을 **실제 답변만 한 크기**로 만든다 (~1.5KB, 코드 블록 포함). 짧은 한 줄로
 * 채우면 화면에 보이는 줄이 몇 개든 마크다운 파싱이 거의 공짜라, 재렌더가 진짜
 * 얼마인지가 안 보인다 — 사람이 겪는 건 긴 답변 몇 개가 화면을 채운 상태다.
 */
async function fill(page: Page, id: string, turns: number) {
  await page.evaluate(
    ({ id, turns }: { id: string; turns: number }) => {
      const m = (window as never as { __mock: any }).__mock
      const body = Array.from(
        { length: 12 },
        (_, k) =>
          `문단 ${k}. \`inline code\` 와 [링크](https://example.com) 가 섞인 제법 긴 줄입니다. 실제 답변이 이만큼은 됩니다.`,
      ).join('\n\n')
      const code = Array.from({ length: 20 }, (_, k) => `  const value${k} = compute(${k}, options)`).join(
        '\n',
      )
      for (let i = 0; i < turns; i++) {
        m.emit({
          type: 'message_delta',
          sessionId: id,
          role: 'assistant',
          text: `## 턴 ${i}\n\n${body}\n\n- 목록 1\n- 목록 2\n- 목록 3\n\n\`\`\`ts\nfunction turn${i}() {\n${code}\n}\n\`\`\`\n`,
        })
        m.emit({ type: 'turn_complete', sessionId: id })
      }
    },
    { id, turns },
  )
  await page.waitForTimeout(300)
}

/**
 * 글자를 하나씩 넣고 **그 프레임이 그려질 때까지**를 잰다.
 *
 * Playwright의 타이핑 대신 in-page에서 재는 이유: keyboard.type은 CDP 왕복이 섞여
 * 재려는 구간(React 렌더 + 레이아웃 + 페인트)보다 잡음이 크다. React가 듣는 것은
 * 결국 네이티브 setter + input 이벤트라, 실제 타이핑과 같은 경로를 탄다.
 */
async function typeAndMeasure(page: Page, keys: number): Promise<Sample> {
  await page.getByTestId('prompt-input').click()
  return page.evaluate(async (keys: number) => {
    const w = window as never as { __commits: number }
    const el = document.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    const times: number[] = []
    w.__commits = 0
    for (let i = 0; i < keys; i++) {
      const t0 = performance.now()
      setter.call(el, el.value + 'a')
      /*
       * 여기서 끝나는 구간을 잰다: React는 input 같은 discrete 이벤트를 **동기로**
       * 흘려보내므로, dispatch가 돌아온 시점이면 렌더·커밋과 useLayoutEffect(높이 재기)가
       * 모두 끝나 있다. rAF까지 기다리면 숫자가 화면 주사율(16.7ms)에 눌려 붙어버려
       * 정작 우리가 줄이려는 일의 크기가 안 보인다.
       */
      el.dispatchEvent(new Event('input', { bubbles: true }))
      times.push(performance.now() - t0)
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
    }
    times.sort((a, b) => a - b)
    const at = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))] ?? 0
    return { p50: at(0.5), p95: at(0.95), max: times[times.length - 1] ?? 0, commits: w.__commits, keys }
  }, keys)
}

/**
 * 답변이 흐르는 동안 친다 — 실제로 버벅인다고 느끼는 순간이 여기다.
 *
 * 에이전트가 말하는 중에 다음 지시를 치는 것은 이 앱의 일상적인 조작이고, 그때
 * 화면은 스트리밍 때문에 이미 계속 다시 그려지고 있다. 타이핑의 비용은 그 위에 얹힌다.
 */
async function stream(page: Page, id: string, on: boolean) {
  await page.evaluate(
    ({ id, on }: { id: string; on: boolean }) => {
      const w = window as never as { __streamTimer?: number; __mock: any }
      if (!on) {
        clearInterval(w.__streamTimer)
        w.__streamTimer = undefined
        return
      }
      w.__mock.emit({ type: 'state_change', sessionId: id, state: 'working' })
      w.__streamTimer = setInterval(() => {
        w.__mock.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: '흐르는 답변 조각. ' })
      }, 30) as never as number
    },
    { id, on },
  )
}

test('한 글자를 치면 얼마가 드는가', async ({ page }) => {
  test.setTimeout(180000)
  const id = await boot(page)

  show('대화 0턴', await typeAndMeasure(page, 40))

  await fill(page, id, 50)
  show('대화 50턴', await typeAndMeasure(page, 40))

  await fill(page, id, 150)
  show('대화 200턴', await typeAndMeasure(page, 40))

  await fill(page, id, 200)
  show('대화 400턴', await typeAndMeasure(page, 40))

  await stream(page, id, true)
  await page.waitForTimeout(500)
  show('대화 400턴 · 답변 흐르는 중', await typeAndMeasure(page, 40))
  await stream(page, id, false)
})
