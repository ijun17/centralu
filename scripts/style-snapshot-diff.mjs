#!/usr/bin/env node
/**
 * Compares two folders written by e2e/style-snapshot.spec.ts and prints every colour that moved.
 *
 *   node scripts/style-snapshot-diff.mjs <before> <after>
 *
 * Exits 1 when a computed colour differs, an element gained or lost one, or a scene was recorded
 * on one side only. Screenshots that are not byte-identical are listed but do not fail the run:
 * two runs of the same code already differ by a few antialiased pixels (a native select, where a
 * focus ring lands), so a pixel difference is a prompt to look at the two PNGs, not a verdict.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [before, after] = process.argv.slice(2)
if (!before || !after) {
  console.error('usage: node scripts/style-snapshot-diff.mjs <before> <after>')
  process.exit(2)
}

const MAX_PER_SCENE = 20
let differences = 0
const screenshots = []

/** Recorded browsers are subfolders (chromium, webkit); compare each that exists on either side. */
const browsers = [...new Set([...readdirSync(before), ...readdirSync(after)])].filter((b) => !b.startsWith('.'))
for (const browser of browsers) {
  const a = join(before, browser)
  const b = join(after, browser)
  if (!existsSync(a) || !existsSync(b)) {
    console.log(`${browser}: recorded on one side only`)
    differences++
    continue
  }
  const scenes = [...new Set([...readdirSync(a), ...readdirSync(b)])].filter((f) => f.endsWith('.json')).sort()
  for (const file of scenes) {
    const scene = `${browser}/${file.replace(/\.json$/, '')}`
    if (!existsSync(join(a, file)) || !existsSync(join(b, file))) {
      console.log(`${scene}: recorded on one side only`)
      differences++
      continue
    }
    const x = JSON.parse(readFileSync(join(a, file), 'utf8'))
    const y = JSON.parse(readFileSync(join(b, file), 'utf8'))
    const lines = []
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      for (const prop of new Set([...Object.keys(x[key] ?? {}), ...Object.keys(y[key] ?? {})])) {
        const was = x[key]?.[prop]
        const now = y[key]?.[prop]
        if (was !== now) lines.push(`  ${key}\n    ${prop}: ${was ?? '(none)'} -> ${now ?? '(none)'}`)
      }
    }
    const shaFile = file.replace(/\.json$/, '.png.sha256')
    const shaA = existsSync(join(a, shaFile)) ? readFileSync(join(a, shaFile), 'utf8') : null
    const shaB = existsSync(join(b, shaFile)) ? readFileSync(join(b, shaFile), 'utf8') : null
    const pixels = shaA !== shaB
    if (pixels) screenshots.push(scene)
    if (lines.length) {
      differences += lines.length
      console.log(`${scene}: ${lines.length} computed difference(s)${pixels ? ', screenshot differs' : ''}`)
      for (const l of lines.slice(0, MAX_PER_SCENE)) console.log(l)
      if (lines.length > MAX_PER_SCENE) console.log(`  … ${lines.length - MAX_PER_SCENE} more`)
    } else {
      console.log(`${scene}: identical (${Object.keys(x).length} elements)${pixels ? ', screenshot differs' : ''}`)
    }
  }
}

if (screenshots.length) console.log(`\nscreenshots to look at (not byte-identical): ${screenshots.join(', ')}`)
console.log(differences ? `\n${differences} computed difference(s)` : '\nno computed differences')
process.exit(differences ? 1 : 0)
