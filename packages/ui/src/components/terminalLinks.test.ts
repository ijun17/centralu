import type { ILinkProvider, Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { findTerminalHttpLinks, isTerminalLinkActivation, registerTerminalHttpLinks } from './terminalLinks.js'

describe('terminal HTTP links', () => {
  it('finds only valid http(s) URLs and leaves sentence punctuation outside', () => {
    expect(findTerminalHttpLinks('Open https://example.com/a?x=1). Then http://localhost:5174/.')).toEqual([
      { text: 'https://example.com/a?x=1', start: 5, end: 30 },
      { text: 'http://localhost:5174/', start: 38, end: 60 },
    ])
  })

  it('requires Command or Control before a terminal link activates', () => {
    expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: false })).toBe(false)
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(true)
  })

  type Links = Parameters<ILinkProvider['provideLinks']>[1] extends (value: infer T) => void ? T : never
  const fakeTerm = (text: string) => {
    let provider: ILinkProvider | undefined
    const term = {
      buffer: { active: { getLine: (line: number) => (line === 3 ? { translateToString: () => text } : undefined) } },
      registerLinkProvider: (next: ILinkProvider) => {
        provider = next
        return { dispose() {} }
      },
    } as unknown as Terminal
    const linksAt = (line: number): Links => {
      let links: Links
      provider!.provideLinks(line, (value) => {
        links = value
      })
      return links!
    }
    return { term, linksAt }
  }

  it('provides one-based xterm ranges for the URL cells', () => {
    const { term, linksAt } = fakeTerm('go https://example.com')
    registerTerminalHttpLinks(term, () => {})
    expect(linksAt(4)).toMatchObject([{ text: 'https://example.com/', range: { start: { x: 4, y: 4 }, end: { x: 22, y: 4 } } }])
  })

  /*
   * 데스크톱 웹뷰(WKWebView)에서 window.open은 아무것도 열지 않는다 — 새 창 처리기가 없으면
   * wry가 요청을 버린다 (#159). 여는 일은 받은 열기 함수(플랫폼 포트)가 해야 한다.
   */
  it('opens an activated link through the given opener, not window.open', () => {
    const { term, linksAt } = fakeTerm('go https://example.com')
    const opened: string[] = []
    registerTerminalHttpLinks(term, (url) => opened.push(url))
    const windowOpen = vi.fn()
    vi.stubGlobal('window', { open: windowOpen })
    try {
      const link = linksAt(4)![0]!
      link.activate({ metaKey: false, ctrlKey: false, preventDefault() {} } as MouseEvent, link.text)
      expect(opened).toEqual([])
      link.activate({ metaKey: true, ctrlKey: false, preventDefault() {} } as MouseEvent, link.text)
      expect(opened).toEqual(['https://example.com/'])
      expect(windowOpen).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
