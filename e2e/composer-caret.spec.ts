import { expect, test } from '@playwright/test'

/**
 * ArrowUp in the composer moves the caret up a wrapped line before it recalls history (#38, #744).
 *
 * The composer decides "is the caret on the first visual line" without an API for it (a textarea
 * has none), and a measurement that wraps differently from the textarea itself answers wrong at
 * the text lengths where the two disagree: in WebKit, ArrowUp on the second wrapped line recalled
 * history, as though the text being typed had vanished. Where those lengths fall depends on the
 * font and the width, so this sweeps word counts across many row boundaries instead of trusting
 * one length that happens to be clear of them. It runs in each engine CI runs (WebKit is the
 * desktop app, Chromium the one on Windows).
 */

const WORD_COUNTS = Array.from({ length: 71 }, (_, i) => 20 + i)

test('ArrowUp moves the caret on every wrapped line before it recalls history, at any text length (#744)', async ({ page }) => {
  test.setTimeout(120_000)
  const input = page.getByTestId('prompt-input')
  await page.goto('/?demo')
  await expect(page.getByTestId('chat-stream')).toBeVisible()
  // Sending is what ends a recall, and puts the message at the top of the history for the next
  // length: a recall left half done by a wrong press would otherwise carry on and hide whether
  // that length is right
  const send = async () => {
    await input.fill('sent message')
    await input.press('Enter')
    await expect(input).toHaveValue('')
  }

  const state = () =>
    input.evaluate((el: HTMLTextAreaElement) => ({
      value: el.value,
      caret: el.selectionStart,
      rows: Math.round(el.scrollHeight / parseFloat(getComputedStyle(el).lineHeight)),
    }))

  const wrong: string[] = []
  const rowsSeen = new Set<number>()
  for (const count of WORD_COUNTS) {
    await send()
    const long = Array.from({ length: count }, (_, i) => `word${i}`).join(' ')
    await input.fill(long)
    const { rows } = await state()
    rowsSeen.add(rows)
    let moved = 0
    for (let i = 1; i < rows; i++) {
      const before = (await state()).caret!
      await input.press('ArrowUp')
      const after = await state()
      if (after.value !== long || after.caret! >= before) break
      moved++
    }
    if (moved !== rows - 1) {
      wrong.push(`${count} words: ${rows} rows, the caret moved on ${moved} of ${rows - 1} presses`)
      continue
    }
    // The press on the first row is the one that recalls
    await input.press('ArrowUp')
    if ((await state()).value !== 'sent message') wrong.push(`${count} words: ArrowUp on the first row did not recall history`)
  }
  // The sweep has to cross several row boundaries, or it proves nothing about them
  expect(rowsSeen.size).toBeGreaterThan(4)
  expect(wrong).toEqual([])
})
