import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { icoImages, missingIcoImages } from '../scripts/icon-check.mjs'

/** The release check that a built exe carries the repository's icon (#1736, `release-npm.mts`) */
const ROOT = join(import.meta.dirname, '..')

/** An .ico of these images, laid out as a resource compiler reads one */
function ico(images: Buffer[]): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach((image, i) => {
    head.writeUInt32LE(image.length, 6 + i * 16 + 8)
    head.writeUInt32LE(offset, 6 + i * 16 + 12)
    offset += image.length
  })
  return Buffer.concat([head, ...images])
}

describe('the icon a built exe carries', () => {
  const a = Buffer.from('\x89PNG first image bytes')
  const b = Buffer.from('BMP second image bytes')

  it('names the images of icon.ico the exe lacks', () => {
    const exe = Buffer.concat([Buffer.from('MZ...'), a, Buffer.from('...rest')])
    expect(missingIcoImages(ico([a, b]), exe)).toEqual([2])
    expect(missingIcoImages(ico([a, b]), Buffer.concat([exe, b]))).toEqual([])
  })

  it('reads the repository icon.ico, and refuses what is not one', () => {
    const images = icoImages(readFileSync(join(ROOT, 'apps/desktop/src-tauri/icons/icon.ico')))
    expect(images.length).toBeGreaterThan(0)
    expect(() => icoImages(Buffer.from('not an icon'))).toThrow(/not an .ico/)
    expect(() => icoImages(ico([a]).subarray(0, 30))).toThrow(/outside the file/)
  })
})
