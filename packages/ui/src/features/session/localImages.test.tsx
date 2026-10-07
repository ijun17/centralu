import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { MessageImage } from '@cc/protocol'
import { MarkdownBlock } from './Markdown.jsx'
import { clearReplyImages, loadReplyImage, localImagePath } from './localImages.js'

afterEach(() => clearReplyImages())

describe('localImagePath', () => {
  it('takes absolute, home, relative, file URL and Windows paths as files', () => {
    expect(localImagePath('/Users/me/Desktop/run/grid.png')).toBe('/Users/me/Desktop/run/grid.png')
    expect(localImagePath('~/shots/a.png')).toBe('~/shots/a.png')
    expect(localImagePath('./out/a.png')).toBe('./out/a.png')
    expect(localImagePath('out/a.png')).toBe('out/a.png')
    expect(localImagePath('file:///tmp/a.png')).toBe('file:///tmp/a.png')
    expect(localImagePath('C:\\shots\\a.png')).toBe('C:\\shots\\a.png')
  })

  it('decodes what Markdown percent-encoded, so the host is asked for the path the reply wrote', () => {
    expect(localImagePath('/tmp/%ED%95%9C%EA%B8%80.png')).toBe('/tmp/한글.png')
    expect(localImagePath('/tmp/a%20b.png')).toBe('/tmp/a b.png')
    expect(localImagePath('/tmp/100%.png')).toBe('/tmp/100%.png')
  })

  it('leaves web addresses and every other scheme alone', () => {
    for (const src of ['https://example.com/a.png', 'http://x/a.png', '//cdn.example.com/a.png', 'data:image/png;base64,AA', 'javascript:alert(1)', 'mailto:a@b', '']) {
      expect(localImagePath(src), src).toBeNull()
    }
  })
})

describe('loadReplyImage', () => {
  const png: MessageImage = { ok: true, mime: 'image/png', data: 'AAAA', file: '/tmp/a.png' }

  it('asks the host once per session and path', async () => {
    const asked: string[] = []
    const ask = async (sid: string, path: string) => {
      asked.push(`${sid} ${path}`)
      return png
    }
    await loadReplyImage(ask, 's1', '/tmp/a.png')
    await loadReplyImage(ask, 's1', '/tmp/a.png')
    await loadReplyImage(ask, 's2', '/tmp/a.png')
    expect(asked).toEqual(['s1 /tmp/a.png', 's2 /tmp/a.png'])
  })

  it('asks again after "not found" and after a failed call, but keeps any other refusal', async () => {
    let calls = 0
    const answers: (MessageImage | Error)[] = [
      { ok: false, reason: 'not_found', message: 'none' },
      new Error('host away'),
      { ok: false, reason: 'too_large', message: 'big' },
      png,
    ]
    const ask = async () => {
      const a = answers[calls++]!
      if (a instanceof Error) throw a
      return a
    }
    expect(await loadReplyImage(ask, 's1', '/a.png')).toMatchObject({ reason: 'not_found' })
    await expect(loadReplyImage(ask, 's1', '/a.png')).rejects.toThrow('host away')
    expect(await loadReplyImage(ask, 's1', '/a.png')).toMatchObject({ reason: 'too_large' })
    expect(await loadReplyImage(ask, 's1', '/a.png')).toMatchObject({ reason: 'too_large' })
    expect(calls).toBe(3)
  })

  it('forgets the oldest answers past its bound, and keeps the recently used', async () => {
    const asked: string[] = []
    const ask = async (_sid: string, path: string) => {
      asked.push(path)
      return png
    }
    for (let i = 0; i < 64; i++) await loadReplyImage(ask, 's', `/${i}.png`)
    // Touch the first, then push one more past 64: the second goes, the first stays
    await loadReplyImage(ask, 's', '/0.png')
    await loadReplyImage(ask, 's', '/64.png')
    asked.length = 0
    await loadReplyImage(ask, 's', '/0.png')
    await loadReplyImage(ask, 's', '/1.png')
    expect(asked).toEqual(['/1.png'])
  })
})

describe('an image in a reply', () => {
  const render = (text: string, sessionId: string | null = 's1') =>
    renderToStaticMarkup(<MarkdownBlock text={text} projectRoot="/p" projectId="p1" sessionId={sessionId} />)

  it('never puts a file path in an img src: the host is asked for it instead', () => {
    const html = render('![Origin comparison](/Users/me/Desktop/run/.test/r1/origin-character-quality-grid.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('data-testid="reply-image-waiting"')
    expect(html).toContain('data-path="/Users/me/Desktop/run/.test/r1/origin-character-quality-grid.png"')
  })

  it('keeps a file URL and an encoded path as the reply wrote them', () => {
    expect(render('![a](file:///tmp/a.png)')).toContain('data-path="file:///tmp/a.png"')
    expect(render('![a](</tmp/my shots/a.png>)')).toContain('data-path="/tmp/my shots/a.png"')
  })

  it('asks for a Windows path as the reply wrote it: backslashes, a drive, a file URL with a drive', () => {
    expect(render('![a](C:\\Users\\me\\shots\\a.png)')).toContain('data-path="C:\\Users\\me\\shots\\a.png"')
    expect(render('![a](C:/Users/me/shots/a.png)')).toContain('data-path="C:/Users/me/shots/a.png"')
    expect(render('![a](file:///C:/Users/me/a.png)')).toContain('data-path="file:///C:/Users/me/a.png"')
  })

  it('leaves a web image an ordinary img, as before', () => {
    expect(render('![logo](https://example.com/logo.png)')).toContain('<img src="https://example.com/logo.png" alt="logo"/>')
  })

  it('draws only the alt text for any other scheme', () => {
    const html = render('![x](javascript:alert(1)) ![y](data:image/png;base64,AAAA)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('javascript')
    expect(html).toContain('x')
  })

  it('does not ask for a local image outside a reply, and says what it was', () => {
    const html = render('![shot](/tmp/a.png)', null)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('reply-image-waiting')
    expect(html).toContain('shot')
  })
})
