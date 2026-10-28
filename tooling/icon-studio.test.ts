import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The icon studio opens with the shipped icon. Its defaults and the settings recorded in
// panes.svg's header must stay the same, or the next export from the studio quietly changes
// the icon.
const sources = new URL('../apps/desktop/src-tauri/icons/sources/', import.meta.url)

function studioDefaults(): Record<string, unknown> {
  const html = readFileSync(new URL('studio.html', sources), 'utf8')
  const literal = /const DEFAULTS = (\{[\s\S]*?\n\});/.exec(html)?.[1]
  if (literal === undefined) throw new Error('studio.html has no DEFAULTS object')
  return runInNewContext(`(${literal})`) as Record<string, unknown>
}

function iconSettings(): Record<string, unknown> {
  const svg = readFileSync(new URL('panes.svg', sources), 'utf8')
  const json = /^(\{.*\}) -->$/m.exec(svg)?.[1]
  if (json === undefined) throw new Error('panes.svg records no settings in its header')
  return JSON.parse(json) as Record<string, unknown>
}

describe('icon studio', () => {
  it('opens with the settings the shipped panes.svg was drawn from', () => {
    expect(studioDefaults()).toEqual(iconSettings())
  })
})
