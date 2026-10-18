import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Platform } from '@cc/platform/ports'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'
import { FileLink } from './Markdown.jsx'

const render = (fileManagerName: string) =>
  renderToStaticMarkup(
    <PlatformProvider platform={{ capabilities: { fileManagerName } } as Platform}>
      <FileLink refInfo={{ path: 'src/a.ts', line: 12 }} projectId="p1">
        src/a.ts
      </FileLink>
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
