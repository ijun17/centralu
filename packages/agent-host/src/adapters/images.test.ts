import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imageEventFromDisk } from './images.js'

/**
 * The IO half of imageView (#40) — reads a path into an event the screen can draw.
 * Contract: an event goes out regardless of what fails, and note states the reason whenever data is empty.
 */

// A real 8x8-pixel PNG (the same file used in the measurement probe)
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFtFEIAJ2yAhH+Iz4jAAAAAElFTkSuQmCC'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-images-'))
  await writeFile(join(dir, 'dot.png'), Buffer.from(PNG_B64, 'base64'))
  await writeFile(join(dir, 'note.txt'), 'not an image')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('imageEventFromDisk', () => {
  it('fills in base64 and mime for a readable image', async () => {
    const e = await imageEventFromDisk('s1', join(dir, 'dot.png'))
    expect(e).toMatchObject({ type: 'message_image', sessionId: 's1', mime: 'image/png', data: PNG_B64 })
  })

  it('an extension outside the list is not drawn, and the reason is stated', async () => {
    const e = await imageEventFromDisk('s1', join(dir, 'note.txt'))
    expect(e).toMatchObject({ data: '', note: expect.stringContaining('format') })
  })

  it('a file over the ceiling states its size', async () => {
    const e = await imageEventFromDisk('s1', join(dir, 'dot.png'), 10)
    expect(e).toMatchObject({ data: '', note: expect.stringContaining('too large') })
  })

  it('a missing file is still an event — a box with a reason beats a silent blank', async () => {
    const e = await imageEventFromDisk('s1', join(dir, 'gone.png'))
    expect(e).toMatchObject({ data: '', note: expect.stringContaining('Failed to read') })
  })
})
