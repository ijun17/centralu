/**
 * Renders the app icon from SVG.
 *
 *   pnpm icon            # re-renders whichever one is currently chosen
 *   pnpm icon grid       # switches to a different candidate (orbit · grid · dot)
 *   pnpm icon --preview  # draws all three side by side at real dock sizes to compare
 *
 * **SVG is kept as the source of truth.** With only a PNG, changing even one color needs an
 * image editor, and the diff shows only "the binary changed". SVG can be read, edited and
 * reviewed.
 *
 * Rendering is done with Playwright (Chromium) — the repository already uses it for e2e, so it
 * is not a new dependency. Requiring rsvg or ImageMagick to be installed separately would keep
 * contributors from running this script at all.
 */
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  console.error(`Unknown candidate: ${pick}\nAvailable choices: ${NAMES.join(' · ')}`)
  process.exit(1)
}

const svg = (name: string) => {
  const p = join(SOURCES, `${name}.svg`)
  if (!existsSync(p)) {
    console.error(`No such SVG: ${p}`)
    process.exit(1)
  }
  return readFileSync(p, 'utf8')
}

const browser = await chromium.launch()
const page = await browser.newPage()

if (preview) {
  /*
   * **Surviving small sizes is the whole job of an icon.**
   * Looked at only at 1024, all three look good. Choosing between them only works by seeing
   * side by side whether the shape survives at dock (128), list (32) and menu bar (16) sizes.
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
  console.log(`Preview: ${out}`)
} else {
  const name = pick ?? readFileSync(join(ICONS, '.chosen'), 'utf8').trim()
  await page.setViewportSize({ width: 1024, height: 1024 })
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;background:transparent} svg{display:block;width:1024px;height:1024px}</style>
    ${svg(name)}`)
  // Rendered with a transparent background — a macOS icon has to be **empty outside** the
  // squircle.
  await page.screenshot({ path: join(ICONS, 'icon.png'), omitBackground: true })
  writeFileSync(join(ICONS, '.chosen'), `${name}\n`)

  /*
   * A single PNG is not enough. When Tauri builds the icns, it maps sizes onto fixed slots,
   * and **1024 is only accepted as "512@2x"**, so a lone 1024 PNG fails to match:
   *
   *     failed to bundle project: Failed to create app icon: `No matching IconType`
   *
   * On top of that, building from a single 512 leaves the largest slot empty and the icon
   * blurs at the dock's maximum size. So the official generator is used to render a
   * **multi-resolution icns** (128, 256, 512, 1024 and their @2x variants).
   */
  await browser.close()
  execFileSync('npx', ['tauri', 'icon', join(ICONS, 'icon.png'), '-o', ICONS], {
    cwd: join(ROOT, 'apps/desktop'),
    stdio: 'ignore',
  })

  /*
   * The generator also produces Android, iOS and Windows assets. This app is macOS-only, so
   * there is no reason to keep them in the repository — unused files pile up, and the next
   * person to find them ends up wondering why they exist.
   */
  for (const junk of ['android', 'ios', 'icon.ico', 'StoreLogo.png', '32x32.png', '64x64.png', '128x128.png', '128x128@2x.png']) {
    rmSync(join(ICONS, junk), { recursive: true, force: true })
  }
  for (const f of readdirSync(ICONS)) if (f.startsWith('Square')) rmSync(join(ICONS, f))

  console.log(`Icon: ${name} → icons/icon.icns (multi-resolution)`)
  console.log('The app has to be rebuilt for this to take effect: pnpm app')
  process.exit(0)
}

await browser.close()
