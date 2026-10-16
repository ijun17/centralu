import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IMAGE_MAX_BYTES, imageEventFromDisk, inlineImageEvent, mcpImageEvents } from './images.js'

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

describe('inline images (#843)', () => {
  it('holds an inline image to the same ceiling as one read from disk, with the same note', () => {
    const over = 'a'.repeat(Math.ceil(((IMAGE_MAX_BYTES + 1) * 4) / 3) + 4)
    expect(inlineImageEvent('s1', 'image/png', over)).toMatchObject({ data: '', note: 'Image is too large (8MB)' })
    expect(inlineImageEvent('s1', '', 'aWJs')).toEqual({ type: 'message_image', sessionId: 's1', mime: 'image/png', data: 'aWJs' })
  })

  it("reads an MCP answer's image content and leaves its text alone", () => {
    expect(mcpImageEvents('s1', [{ type: 'text', text: 'x' }, { type: 'image', data: 'aWJs', mimeType: 'image/webp' }, { type: 'image' }])).toEqual([
      { type: 'message_image', sessionId: 's1', mime: 'image/webp', data: 'aWJs' },
      { type: 'message_image', sessionId: 's1', mime: '', data: '', note: 'The tool sent an image with no data' },
    ])
    expect(mcpImageEvents('s1', null)).toEqual([])
  })
})
