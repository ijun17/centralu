import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IMAGE_MAX_BYTES, imageEventFromDisk, inlineImageEvent, mcpImageEvents, sniffImage } from './images.js'

/**
 * The IO half of imageView (#40) — reads a path into an event the screen can draw.
 * Contract: an event goes out regardless of what fails, and note states the reason whenever data is empty.
 */

// A real 8x8-pixel PNG (the same file used in the measurement probe)
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFtFEIAJ2yAhH+Iz4jAAAAAElFTkSuQmCC'

// A real animated GIF (3 frames, 24x24): the trailer is found by walking its blocks, as its data holds 0x3b bytes too
const GIF_B64 =
  'R0lGODlhGAAYAIEAAAAUyAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQABQAAACwAAAAAGAAYAAAIKQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDPgwIACH5BAEFAAEALAAAAAAYABgAgVAUyAAAAAAAAAAAAAgpAAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEM+DAgAIfkEAQUAAQAsAAAAABgAGACBoBTIAAAAAAAAAAAACCkAAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQz4MCAA7'
const GIF = Buffer.from(GIF_B64, 'base64')

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
    expect(e).toMatchObject({ data: '', path: join(dir, 'gone.png'), note: 'the file is gone' })
  })

  /*
   * #1464: bytes that are there but no picture were sent whole, and the window drew an empty framed box (WebKit paints
   * nothing for an image it cannot decode). The host says why instead of sending them.
   */
  it('a file cut short (read while the tool is still writing it) is not sent as a picture', async () => {
    const whole = Buffer.from(PNG_B64, 'base64')
    await writeFile(join(dir, 'cut.png'), whole.subarray(0, whole.length - 20))
    const e = await imageEventFromDisk('s1', join(dir, 'cut.png'))
    expect(e).toMatchObject({ data: '', mime: '', path: join(dir, 'cut.png'), note: expect.stringContaining('cut short') })
  })

  it('a file named .png that holds something else is not sent as a picture', async () => {
    await writeFile(join(dir, 'text.png'), 'this is text, not a picture')
    const e = await imageEventFromDisk('s1', join(dir, 'text.png'))
    expect(e).toMatchObject({ data: '', note: 'the file is not a valid .png image' })
  })

  it('an empty file, or one holding only the start of a signature, is still being written, not an invalid image (#1464)', async () => {
    await writeFile(join(dir, 'empty.png'), '')
    expect(await imageEventFromDisk('s1', join(dir, 'empty.png'))).toMatchObject({ data: '', note: 'the file is cut short (0 bytes): it may still be being written' })
    await writeFile(join(dir, 'start.png'), Buffer.from([0x89, 0x50, 0x4e]))
    expect(await imageEventFromDisk('s1', join(dir, 'start.png'))).toMatchObject({ data: '', note: 'the file is cut short (3 bytes): it may still be being written' })
  })

  it('a valid GIF with bytes after its end is sent (#1464)', async () => {
    await writeFile(join(dir, 'padded.gif'), Buffer.concat([GIF, Buffer.alloc(64)]))
    expect(await imageEventFromDisk('s1', join(dir, 'padded.gif'))).toMatchObject({ mime: 'image/gif' })
  })

  it('the mime comes from the bytes: a PNG saved as .jpg is still drawn', async () => {
    await writeFile(join(dir, 'really-png.jpg'), Buffer.from(PNG_B64, 'base64'))
    expect(await imageEventFromDisk('s1', join(dir, 'really-png.jpg'))).toMatchObject({ mime: 'image/png', data: PNG_B64 })
  })
})

describe('a whole picture is never held back for what follows its end (#1464)', () => {
  it('draws a PNG with bytes after IEND, a JPEG with a trailer, and a GIF with padding', () => {
    const png = Buffer.from(PNG_B64, 'base64')
    expect(sniffImage(Buffer.concat([png, Buffer.alloc(300, 7)]))).toEqual({ mime: 'image/png', complete: true })
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]), Buffer.alloc(5000, 9)])
    expect(sniffImage(jpeg)).toEqual({ mime: 'image/jpeg', complete: true })
    // Padding after the trailer: 64 bytes, well past where a search from the back would look (browsers draw it)
    expect(sniffImage(Buffer.concat([GIF, Buffer.alloc(64)]))).toEqual({ mime: 'image/gif', complete: true })
  })

  it('a text file that starts with BM is no picture, and a reason never names the path', async () => {
    expect(sniffImage(Buffer.from('BMW is a car maker, and this is a text file about them'))).toBeNull()
    await writeFile(join(dir, 'noext'), 'text')
    const e = await imageEventFromDisk('s1', join(dir, 'noext'))
    expect(e).toMatchObject({ data: '', note: 'the file is not a picture' })
    // A dot in the folder's name is not the file's extension
    await mkdir(join(dir, 'my.dir'), { recursive: true })
    await writeFile(join(dir, 'my.dir', 'shot'), 'text')
    expect(await imageEventFromDisk('s1', join(dir, 'my.dir', 'shot'))).toMatchObject({ note: 'the file is not a picture' })
    // A folder named like a picture: the system's own message holds the whole path, the note says what it is
    await mkdir(join(dir, 'folder.png'), { recursive: true })
    const folder = await imageEventFromDisk('s1', join(dir, 'folder.png'))
    expect(folder).toMatchObject({ data: '', note: expect.any(String) })
    expect(folder.type === 'message_image' ? folder.note : '').not.toContain('folder.png')
  })
})

describe('sniffImage (#1464)', () => {
  const jpeg = (tail: number[]) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, ...tail])
  it('tells a whole file from a cut one, per format', () => {
    expect(sniffImage(Buffer.from(PNG_B64, 'base64'))).toEqual({ mime: 'image/png', complete: true })
    expect(sniffImage(jpeg([0xff, 0xd9]))).toEqual({ mime: 'image/jpeg', complete: true })
    expect(sniffImage(jpeg([1, 2, 3]))).toEqual({ mime: 'image/jpeg', complete: false })
    expect(sniffImage(GIF)).toEqual({ mime: 'image/gif', complete: true })
    // Every cut of the file short of its trailer is cut short, whatever bytes it ends on
    for (let cut = 6; cut < GIF.length; cut++) expect(sniffImage(GIF.subarray(0, cut))).toEqual({ mime: 'image/gif', complete: false })
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(16)])
    expect(sniffImage(webp)).toEqual({ mime: 'image/webp', complete: true })
    expect(sniffImage(webp.subarray(0, 20))).toEqual({ mime: 'image/webp', complete: false })
    expect(sniffImage(Buffer.from('plain text'))).toBeNull()
  })
})

describe('inline images (#843)', () => {
  it('holds an inline image to the same ceiling as one read from disk, with the same note', () => {
    const over = 'a'.repeat(Math.ceil(((IMAGE_MAX_BYTES + 1) * 4) / 3) + 4)
    expect(inlineImageEvent('s1', 'image/png', over)).toMatchObject({ data: '', note: 'too large (8.0 MB)' })
    expect(inlineImageEvent('s1', '', 'aWJs')).toEqual({ type: 'message_image', sessionId: 's1', mime: 'image/png', data: 'aWJs' })
  })

  it('holds an inline image cut short to the same check as one read from disk, and takes its mime from the bytes (#1464)', () => {
    const png = Buffer.from(PNG_B64, 'base64')
    expect(inlineImageEvent('s1', 'image/png', png.subarray(0, 30).toString('base64'))).toMatchObject({ data: '', note: 'the file is cut short (30 bytes): it may still be being written' })
    expect(inlineImageEvent('s1', 'image/png', '')).toMatchObject({ data: '', note: 'the file is cut short (0 bytes): it may still be being written' })
    expect(inlineImageEvent('s1', 'image/jpeg', PNG_B64)).toMatchObject({ mime: 'image/png', data: PNG_B64 })
  })

  it("reads an MCP answer's image content and leaves its text alone", () => {
    expect(mcpImageEvents('s1', [{ type: 'text', text: 'x' }, { type: 'image', data: 'aWJs', mimeType: 'image/webp' }, { type: 'image' }])).toEqual([
      { type: 'message_image', sessionId: 's1', mime: 'image/webp', data: 'aWJs' },
      { type: 'message_image', sessionId: 's1', mime: '', data: '', note: 'the tool sent it with no data' },
    ])
    expect(mcpImageEvents('s1', null)).toEqual([])
  })
})
