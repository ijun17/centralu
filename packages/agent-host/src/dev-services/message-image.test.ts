import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMAGE_PREVIEW_MAX_BYTES } from '@cc/protocol'
import { mentions, readMessageImage, resolveWrittenPath, sniffImage } from './message-image.js'

/** The smallest bytes each format's signature accepts, padded so the file is not empty past the signature */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

let dir = ''
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-msg-image-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('sniffImage', () => {
  it('names PNG, JPEG, GIF and WebP by their first bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(GIF)).toBe('image/gif')
    expect(sniffImage(Buffer.from('GIF87a'))).toBe('image/gif')
    expect(sniffImage(WEBP)).toBe('image/webp')
  })

  it('takes neither text, an SVG, a RIFF that is not WebP, nor a signature cut short', () => {
    expect(sniffImage(Buffer.from('just text'))).toBeNull()
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'))).toBeNull()
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVE')]))).toBeNull()
    expect(sniffImage(PNG.subarray(0, 7))).toBeNull()
    expect(sniffImage(Buffer.alloc(0))).toBeNull()
  })
})

describe('mentions', () => {
  it('finds a path as a Markdown image destination, in angle brackets, with a title, and as a reference', () => {
    expect(mentions('Here: ![shot](/tmp/a/shot.png)', '/tmp/a/shot.png')).toBe(true)
    expect(mentions('![shot](</tmp/a b/shot.png>)', '/tmp/a b/shot.png')).toBe(true)
    expect(mentions('![shot](/tmp/a/shot.png "the grid")', '/tmp/a/shot.png')).toBe(true)
    expect(mentions('![shot][1]\n\n[1]: /tmp/a/shot.png', '/tmp/a/shot.png')).toBe(true)
  })

  it('does not take a path that is only part of a longer one the reply wrote', () => {
    // `shot.png` would resolve against the session's folder, a different file from the one the reply named
    expect(mentions('![shot](/tmp/a/shot.png)', 'shot.png')).toBe(false)
    expect(mentions('![shot](/tmp/a/shot.png)', 'a/shot.png')).toBe(false)
    expect(mentions('![shot](/tmp/a/shot.png.bak)', '/tmp/a/shot.png')).toBe(false)
    expect(mentions('![shot](/tmp/a/shot.png)', '/tmp/a/shot')).toBe(false)
  })

  it('takes the decoded form the window sends for a destination the reply percent-encoded', () => {
    expect(mentions('![x](/tmp/a%20b.png)', '/tmp/a b.png')).toBe(true)
    expect(mentions('![x](/tmp/한글.png)', '/tmp/한글.png')).toBe(true)
  })
})

describe('resolveWrittenPath', () => {
  it('reads a relative path against the session folder, ~ as home, and a file URL as its path', () => {
    expect(resolveWrittenPath('out/a.png', '/work/p')).toBe('/work/p/out/a.png')
    expect(resolveWrittenPath('../a.png', '/work/p')).toBe('/work/a.png')
    expect(resolveWrittenPath('/abs/a.png', '/work/p')).toBe('/abs/a.png')
    expect(resolveWrittenPath('~/Desktop/a.png', '/work/p', '/home/me')).toBe('/home/me/Desktop/a.png')
    expect(resolveWrittenPath('~', '/work/p', '/home/me')).toBe('/home/me')
    expect(resolveWrittenPath('~/x.png', '/work/p')).toBe(join(homedir(), 'x.png'))
    expect(resolveWrittenPath(pathToFileURL('/tmp/a b.png').href, '/work/p')).toBe('/tmp/a b.png')
  })

  it('refuses a file URL that names another host', () => {
    expect(resolveWrittenPath('file://server/share/a.png', '/work/p')).toBeNull()
  })
})

describe('readMessageImage', () => {
  it('returns each of the four formats with its type and the resolved path', async () => {
    for (const [name, bytes, mime] of [
      ['a.png', PNG, 'image/png'],
      ['a.jpg', JPEG, 'image/jpeg'],
      ['a.gif', GIF, 'image/gif'],
      ['a.webp', WEBP, 'image/webp'],
    ] as const) {
      writeFileSync(join(dir, name), bytes)
      const got = await readMessageImage(join(dir, name))
      expect(got).toEqual({ ok: true, mime, data: bytes.toString('base64'), file: join(dir, name) })
    }
  })

  it('goes by the bytes, not the name: a text file called .png is refused, a PNG called .txt is shown', async () => {
    writeFileSync(join(dir, 'fake.png'), 'not an image')
    expect(await readMessageImage(join(dir, 'fake.png'))).toMatchObject({ ok: false, reason: 'not_an_image', file: join(dir, 'fake.png') })
    writeFileSync(join(dir, 'real.txt'), PNG)
    expect(await readMessageImage(join(dir, 'real.txt'))).toMatchObject({ ok: true, mime: 'image/png' })
  })

  it('refuses an SVG', async () => {
    writeFileSync(join(dir, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(await readMessageImage(join(dir, 'a.svg'))).toMatchObject({ ok: false, reason: 'not_an_image' })
  })

  it('says a missing file is missing, and offers no file to reveal', async () => {
    const got = await readMessageImage(join(dir, 'gone.png'))
    expect(got).toMatchObject({ ok: false, reason: 'not_found' })
    expect(got).not.toHaveProperty('file')
  })

  it('follows a link to an image and reads the target, and refuses a link to something that is not one', async () => {
    writeFileSync(join(dir, 'real.png'), PNG)
    writeFileSync(join(dir, 'secret.txt'), 'token=abc')
    symlinkSync(join(dir, 'real.png'), join(dir, 'to-image.png'))
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'to-text.png'))
    symlinkSync(join(dir, 'nowhere.png'), join(dir, 'dangling.png'))
    expect(await readMessageImage(join(dir, 'to-image.png'))).toMatchObject({ ok: true, file: join(dir, 'real.png') })
    const text = await readMessageImage(join(dir, 'to-text.png'))
    expect(text).toMatchObject({ ok: false, reason: 'not_an_image', file: join(dir, 'secret.txt') })
    expect(JSON.stringify(text)).not.toContain('token=abc')
    expect(await readMessageImage(join(dir, 'dangling.png'))).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('refuses a folder, a device and a pipe without reading from them', async () => {
    mkdirSync(join(dir, 'shots.png'))
    expect(await readMessageImage(join(dir, 'shots.png'))).toMatchObject({ ok: false, reason: 'not_an_image' })
    if (process.platform !== 'win32') {
      expect(await readMessageImage('/dev/zero')).toMatchObject({ ok: false, reason: 'not_an_image' })
      // A read from a pipe with no writer would fail (or, without O_NONBLOCK, wait for one) instead of answering
      execFileSync('mkfifo', [join(dir, 'pipe.png')])
      expect(await readMessageImage(join(dir, 'pipe.png'))).toMatchObject({ ok: false, reason: 'not_an_image' })
    }
  })

  it('shows an image of exactly the cap and refuses one byte more, at every size around a small cap', async () => {
    const max = 16
    for (let size = 0; size <= max * 3; size++) {
      const bytes = Buffer.alloc(size)
      PNG.copy(bytes, 0, 0, Math.min(size, PNG.length))
      writeFileSync(join(dir, 'sized.png'), bytes)
      const got = await readMessageImage(join(dir, 'sized.png'), max)
      if (size > max) expect(got, `size ${size}`).toMatchObject({ ok: false, reason: 'too_large' })
      // The PNG signature is its first 8 bytes
      else if (size < 8) expect(got, `size ${size}`).toMatchObject({ ok: false, reason: 'not_an_image' })
      else expect(got, `size ${size}`).toMatchObject({ ok: true, data: bytes.toString('base64') })
    }
  })

  it('refuses a PNG past the real 10 MB cap without reading it', async () => {
    const big = Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES + 1)
    PNG.copy(big)
    writeFileSync(join(dir, 'big.png'), big)
    const got = await readMessageImage(join(dir, 'big.png'))
    expect(got).toMatchObject({ ok: false, reason: 'too_large', file: join(dir, 'big.png') })
    expect(got).not.toHaveProperty('data')
  })
})
