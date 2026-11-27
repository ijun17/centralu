import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Platform } from '@cc/platform/ports'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'
import { FileLink, MarkdownBlock } from './Markdown.jsx'

const render = (fileManagerName: string) =>
  renderToStaticMarkup(
    <PlatformProvider platform={{ capabilities: { fileManagerName } } as Platform}>
      <FileLink refInfo={{ path: 'src/a.ts', line: 12 }} projectId="p1">
        src/a.ts
      </FileLink>
    </PlatformProvider>,
  )

const renderMd = (text: string, opts: { projectRoot?: string | null; sessionId?: string | null } = {}) =>
  renderToStaticMarkup(
    <PlatformProvider platform={{ capabilities: { fileManagerName: 'Finder' } } as Platform}>
      <MarkdownBlock
        text={text}
        projectRoot={opts.projectRoot === undefined ? '/Users/me/proj' : opts.projectRoot}
        projectId="p1"
        sessionId={opts.sessionId === undefined ? 's1' : opts.sessionId}
      />
    </PlatformProvider>,
  )

// #1143 U23: the tooltip hard-coded "Finder", which is wrong on Windows and Linux
describe("a file link's tooltip names the platform's file manager", () => {
  it('on Windows', () => {
    const html = render('Explorer')
    expect(html).toContain('Right-click: Reveal in Explorer')
    expect(html).not.toContain('Finder')
  })

  it('on macOS', () => {
    expect(render('Finder')).toContain('Right-click: Reveal in Finder')
  })

  it('and still says what it opens', () => {
    expect(render('Explorer')).toContain('Open src/a.ts at line 12')
  })
})

describe('Markdown link routing (internal, external local, web, unsafe)', () => {
  it('renders external Korean image and archive links as external-file-link buttons without DOM href', () => {
    const md =
      '[수정본 미리보기](/Users/ijun17/Downloads/자동사냥-배속-배너/미리보기.png) · ' +
      '[PNG 4종 다운로드](/Users/ijun17/Downloads/자동사냥-배속-배너/상점용-PNG.zip)'
    const html = renderMd(md)
    expect(html).not.toContain('<a ')
    expect(html).toContain('data-testid="external-file-link"')
    expect(html).toContain('data-path="/Users/ijun17/Downloads/자동사냥-배속-배너/미리보기.png"')
    expect(html).toContain('Preview /Users/ijun17/Downloads/자동사냥-배속-배너/미리보기.png · Right-click: Reveal in Finder')
    expect(html).toContain('data-path="/Users/ijun17/Downloads/자동사냥-배속-배너/상점용-PNG.zip"')
    expect(html).toContain('Reveal /Users/ijun17/Downloads/자동사냥-배속-배너/상점용-PNG.zip in Finder')
  })

  it('renders file:// links with #L line anchors and Unicode project paths as FileLink buttons', () => {
    const html = renderMd('[Markdown.tsx](file:///Users/me/proj/src/Markdown.tsx#L10-L20) and [가이드](docs/한글-가이드.md)')
    expect(html).not.toContain('<a ')
    expect(html).toContain('data-testid="file-link"')
    expect(html).toContain('Open src/Markdown.tsx at line 10')
    expect(html).toContain('Open docs/한글-가이드.md · Right-click: Reveal in Finder')
  })

  it('supports external local file links in assistant sessions (projectRoot: null) when sessionId is present, but leaves them plain text without sessionId', () => {
    const inAssistant = renderMd('[log](/tmp/out.log)', { projectRoot: null, sessionId: 's1' })
    expect(inAssistant).toContain('data-testid="external-file-link"')
    expect(inAssistant).toContain('data-path="/tmp/out.log"')

    const outsideReply = renderMd('[log](/tmp/out.log)', { projectRoot: '/Users/me/proj', sessionId: null })
    expect(outsideReply).not.toContain('external-file-link')
    expect(outsideReply).not.toContain('<a ')
    expect(outsideReply).toContain('log')
  })

  it('routes ~/ home links to external-file-link even inside a project session', () => {
    const html = renderMd('[ZIP](~/Downloads/상점용-PNG.zip) · [Shot](~/Desktop/preview.png)')
    expect(html).not.toContain('data-testid="file-link"')
    expect(html).toContain('data-testid="external-file-link"')
    expect(html).toContain('data-path="~/Downloads/상점용-PNG.zip"')
    expect(html).toContain('data-path="~/Desktop/preview.png"')
  })

  it('never renders unsafe schemes, off-machine file:// hosts, UNC paths, bare dotfiles, or fragment-only links as buttons or DOM anchors', () => {
    const html = renderMd(
      '[xss](javascript:alert(1)) [data](data:text/html,hi) [unc](file://evil/share/a.txt) [unc2](file:////server/share/a.txt) [dot](.env) [top](#overview)',
    )
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('xss')
    expect(html).toContain('dot')
    expect(html).toContain('top')
  })

  it('keeps https links as normal anchors', () => {
    const html = renderMd('[Docs](https://example.com/docs)')
    expect(html).toContain('<a href="https://example.com/docs"')
  })
})
