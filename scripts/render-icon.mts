/**
 * 앱 아이콘을 SVG에서 굽는다.
 *
 *   pnpm icon            # 지금 고른 것을 다시 굽는다
 *   pnpm icon grid       # 후보를 갈아 끼운다 (orbit · grid · dot)
 *   pnpm icon --preview  # 셋을 실제 Dock 크기로 나란히 그려 비교한다
 *
 * **SVG를 원본으로 둔다.** PNG만 두면 색 하나 바꾸는 데도 이미지 편집기가 필요하고,
 * diff에는 "바이너리가 바뀌었다"만 남는다. SVG는 읽히고, 고쳐지고, 리뷰된다.
 *
 * 굽는 도구는 Playwright(크로미움)다 — 저장소가 이미 e2e로 쓰고 있어서 새 의존이 아니다.
 * rsvg·ImageMagick을 새로 깔게 하면 기여자가 이 스크립트를 못 돌린다.
 */
import { chromium } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICONS = join(ROOT, 'apps/desktop/src-tauri/icons')
const SOURCES = join(ICONS, 'sources')
const NAMES = ['orbit', 'grid', 'dot'] as const

const args = process.argv.slice(2)
const preview = args.includes('--preview')
const pick = args.find((a) => !a.startsWith('--'))

if (pick && !NAMES.includes(pick as (typeof NAMES)[number])) {
  console.error(`모르는 후보: ${pick}\n고를 수 있는 것: ${NAMES.join(' · ')}`)
  process.exit(1)
}

const svg = (name: string) => {
  const p = join(SOURCES, `${name}.svg`)
  if (!existsSync(p)) {
    console.error(`SVG가 없다: ${p}`)
    process.exit(1)
  }
  return readFileSync(p, 'utf8')
}

const browser = await chromium.launch()
const page = await browser.newPage()

if (preview) {
  /*
   * **작은 크기에서 살아남는지가 아이콘의 전부다.**
   * 1024로만 보면 셋 다 좋아 보인다. Dock(128)·목록(32)·메뉴바(16)에서 형태가
   * 남는지를 나란히 봐야 고를 수 있다.
   */
  const sizes = [128, 64, 32, 16]
  const cell = (name: string) => `
    <div class="col">
      <div class="name">${name}</div>
      ${sizes.map((s) => `<div class="row" style="height:${s}px"><div style="width:${s}px;height:${s}px">${svg(name)}</div><span>${s}px</span></div>`).join('')}
    </div>`
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>
      body { margin:0; background:#c8c8cc; display:flex; gap:40px; padding:28px; font:12px ui-monospace,monospace; color:#222 }
      svg { width:100%; height:100% }
      .col { display:flex; flex-direction:column; gap:18px; align-items:flex-start }
      .name { font-weight:600 }
      .row { display:flex; align-items:center; gap:10px }
      .row span { color:#555 }
    </style>
    ${NAMES.map(cell).join('')}`)
  const out = join(ROOT, 'icon-preview.png')
  await page.locator('body').screenshot({ path: out })
  console.log(`미리보기: ${out}`)
} else {
  const name = pick ?? readFileSync(join(ICONS, '.chosen'), 'utf8').trim()
  await page.setViewportSize({ width: 1024, height: 1024 })
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;background:transparent} svg{display:block;width:1024px;height:1024px}</style>
    ${svg(name)}`)
  // 투명 배경으로 굽는다 — macOS 아이콘은 스퀘어클 **밖이 비어 있어야** 한다
  await page.screenshot({ path: join(ICONS, 'icon.png'), omitBackground: true })
  writeFileSync(join(ICONS, '.chosen'), `${name}\n`)
  console.log(`아이콘: ${name} → icons/icon.png (1024×1024)`)
  console.log('앱에 반영하려면 다시 빌드해야 한다: pnpm app')
}

await browser.close()
