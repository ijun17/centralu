import { expect, test, type Page } from '@playwright/test'

/**
 * 파일 트리가 파일을 **바꾸는** 쪽 (#18, #19).
 *
 * 지금까지 트리는 보여주기만 했다. 여기서 묻는 것은 네 가지가 실제로 일어나는가와,
 * 그보다 중요한 **일어나지 않아야 할 때 안 일어나는가**이다: 자리가 차 있으면 덮지 않는가,
 * 지운 것이 되돌릴 수 있는 곳으로 갔다고 말해 주는가, 그리고 원래 있던 드래그(경로를
 * 입력창에 넣기)가 새 드래그에 밀려나지 않았는가.
 *
 * 별도 파일인 이유도 그것이다. control-loop는 관제 루프 한 바퀴를 보고, panel은 여럿이
 * 떠 있을 때 화면이 무엇을 고르는지를 본다. 여기는 **파일이 움직이는가**만 본다.
 */

async function setup(page: Page, path = '/tmp/alpha') {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate((p: string) => {
    ;(window as any).__mock.nextPickedDirectory = p
  }, path)
  await page.getByTestId('orchestrator-pick-folder').click()
  // 첫 등록은 세션 만들기로 곧장 이어진다 — 여기서는 프로젝트만 필요하므로 닫는다
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
}

/** 목의 파일 트리를 그린다. `entries`는 "부모 경로 → 그 안의 항목들" */
async function seedTree(page: Page, entries: Record<string, { name: string; isDir?: boolean; ignored?: boolean }[]>) {
  await page.evaluate((e: Record<string, { name: string; isDir?: boolean; ignored?: boolean }[]>) => {
    const m = (window as any).__mock
    for (const [dir, items] of Object.entries(e)) {
      m.fsState.entries[dir] = items.map((i) => ({
        name: i.name,
        path: dir ? `${dir}/${i.name}` : i.name,
        isDir: !!i.isDir,
        ignored: !!i.ignored,
      }))
      for (const i of items) if (i.isDir) m.fsState.entries[dir ? `${dir}/${i.name}` : i.name] ??= []
    }
  }, entries)
}

async function openTree(page: Page, prompt = 'work') {
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // 첫 지시는 모달이 아니라 입력창에서 — 다이얼로그에는 프롬프트 칸이 없다 (#8)
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-tree')).toBeVisible()
}

/*
 * ── 오른쪽 클릭이 여는 것 ────────────────────────────────────────────
 */

/**
 * 지우기는 **되돌릴 수 있는 곳으로 보내는 것**이다 (#18).
 *
 * 확인 대화상자가 없는 것이 빠뜨린 것이 아니라 결정이라서, 토스트가 어디로 갔는지 말해야
 * 한다 — 줄이 사라지는 것만으로는 "사라졌다"까지밖에 전해지지 않는다.
 */
test('오른쪽 클릭 → 휴지통: 줄이 사라지고, 어디로 갔는지 말해 준다', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'a.ts' }, { name: 'keep.ts' }] })
  await openTree(page)

  await expect(page.getByTestId('file-a.ts')).toBeVisible()
  await page.getByTestId('file-a.ts').click({ button: 'right' })
  await expect(page.getByTestId('file-menu')).toBeVisible()
  await page.getByTestId('file-menu-trash').click()

  await expect(page.getByTestId('file-a.ts')).toBeHidden()
  // 옆줄은 그대로여야 한다 — 목록이 통째로 날아간 것과 한 줄이 없어진 것은 다르다
  await expect(page.getByTestId('file-keep.ts')).toBeVisible()
  await expect(page.getByTestId('toast')).toContainText('Trash')

  // 진짜 OS 휴지통으로 갔는가 (지우기가 아니라) — 포트가 받은 것을 본다
  expect(await page.evaluate(() => (window as any).__mock.trashed)).toEqual(['a.ts'])
})

/** 이름은 이 데스크톱이 부르는 대로 나온다 — UI는 어느 OS인지 묻지 않는다 (#32와 같은 규칙) */
test('오른쪽 클릭 → 파일 관리자에서 보기', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'a.ts' }] })
  await openTree(page)

  await page.getByTestId('file-a.ts').click({ button: 'right' })
  await expect(page.getByTestId('file-menu-reveal')).toContainText('Reveal in Finder')
  await page.getByTestId('file-menu-reveal').click()

  await expect(page.getByTestId('file-menu')).toBeHidden()
  expect(await page.evaluate(() => (window as any).__mock.revealed)).toEqual(['a.ts'])
})

/** 무시된 파일도 그냥 파일이다 (#17) — 보이는 이상 다룰 수도 있어야 한다 */
test('.gitignore에 걸린 파일도 휴지통으로 보낼 수 있다', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: '.env.local', ignored: true }] })
  await openTree(page)

  await page.getByTestId('file-.env.local').click({ button: 'right' })
  await page.getByTestId('file-menu-trash').click()
  await expect(page.getByTestId('toast')).toContainText('.env.local')
  expect(await page.evaluate(() => (window as any).__mock.trashed)).toEqual(['.env.local'])
})

/*
 * ── 끌어다 놓기: 같은 손짓이 놓는 곳에 따라 달라진다 ──────────────────
 */

test('폴더 위에 놓으면 파일이 그리로 옮겨간다', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'src', isDir: true }, { name: 'a.ts' }], src: [] })
  await openTree(page)

  await page.getByTestId('file-a.ts').dragTo(page.getByTestId('dir-src'))

  await expect(page.getByTestId('file-a.ts')).toBeHidden()
  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()
})

/**
 * **덮어쓰기는 없다** — 그 자리의 파일이 에이전트가 지금 고치고 있는 것일 수 있고,
 * 조용히 갈아치우는 것은 되돌릴 방법이 하나도 없는 유일한 결과다.
 */
test('자리가 차 있으면 옮기지 않고 무엇과 부딪혔는지 말한다', async ({ page }) => {
  await setup(page)
  await seedTree(page, {
    '': [{ name: 'src', isDir: true }, { name: 'a.ts' }],
    src: [{ name: 'a.ts' }],
  })
  await openTree(page)

  await page.getByTestId('file-a.ts').dragTo(page.getByTestId('dir-src'))

  await expect(page.getByTestId('toast')).toContainText('src/a.ts already exists')
  // 원본은 제자리에 남는다 — 반쯤 옮겨진 상태가 가장 나쁘다
  await expect(page.getByTestId('file-a.ts')).toBeVisible()
  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()
})

/** 폴더 안의 것을 다시 밖으로 — 루트는 자기 줄이 없어서 빈 공간이 그 자리를 맡는다 */
test('트리의 빈 공간에 놓으면 프로젝트 루트로 나온다', async ({ page }) => {
  await setup(page)
  await seedTree(page, {
    '': [{ name: 'src', isDir: true }],
    src: [{ name: 'a.ts' }],
  })
  await openTree(page)
  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/a.ts')).toBeVisible()

  await page.getByTestId('file-src/a.ts').dragTo(page.getByTestId('file-drop-root'), {
    // 폴더 줄 위가 아니라 목록 아래의 빈 공간에 떨어뜨린다
    targetPosition: { x: 40, y: 120 },
  })

  await expect(page.getByTestId('file-a.ts')).toBeVisible()
  await expect(page.getByTestId('file-src/a.ts')).toBeHidden()
})

/**
 * 밖에서 끌어온 파일 (#19의 둘째).
 *
 * OS 드롭은 사람 손으로만 만들 수 있어서 여기서는 이벤트를 직접 만들어 던진다 —
 * 확인하려는 것은 브라우저의 드래그 구현이 아니라 **`Files`가 실린 드롭을 우리가 어떻게
 * 가르는가**이다. 트리에서 온 것과 달리 우리 MIME이 없고, 그것이 유일한 구분이다.
 */
test('핀더에서 끌어온 파일은 놓은 폴더에 들어온다', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'src', isDir: true }], src: [] })
  await openTree(page)

  const dt = await page.evaluateHandle(() => {
    const t = new DataTransfer()
    t.items.add(new File(['shot'], 'dropped.png', { type: 'image/png' }))
    return t
  })
  await page.dispatchEvent('[data-testid="file-drop-src"]', 'dragover', { dataTransfer: dt })
  await page.dispatchEvent('[data-testid="file-drop-src"]', 'drop', { dataTransfer: dt })

  await page.getByTestId('dir-src').click()
  await expect(page.getByTestId('file-src/dropped.png')).toBeVisible()
})

/**
 * 원래 있던 드래그가 살아 있는가 (#19가 명시적으로 걱정한 것).
 *
 * 같은 줄을 끄는 손짓 하나가 이제 두 가지를 뜻한다. 가르는 것은 **떨어뜨린 곳**이다:
 * 입력창은 경로를 문장에 넣고, 트리는 파일을 옮긴다. 옮기기를 붙이면서 끌기 자체의
 * 성질(`effectAllowed`)을 건드렸기 때문에, 이쪽이 조용히 죽지 않았는지 확인해야 한다 —
 * 죽는 모양이 정확히 '아무 일도 안 일어남'이라 눈으로는 못 잡는다.
 */
test('입력창에 놓으면 예전처럼 경로가 문장에 들어간다', async ({ page }) => {
  await setup(page)
  await seedTree(page, { '': [{ name: 'a.ts' }] })
  await openTree(page)

  await page.getByTestId('file-a.ts').dragTo(page.getByTestId('input-dropzone'))

  await expect(page.getByTestId('input-dropzone').locator('textarea')).toHaveValue('@a.ts ')
  // 옮긴 것이 아니라 가리킨 것이다 — 파일은 그대로 있어야 한다
  await expect(page.getByTestId('file-a.ts')).toBeVisible()
})
