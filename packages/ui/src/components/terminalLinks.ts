import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

/**
 * Link detection for the three terminals, in one place so they all link alike. Only `http(s)`: terminal output is
 * untrusted, so `file:` or `javascript:` must not become clickable (project files open through FileLink instead).
 */
const HTTP_URL = /https?:\/\/[^\s<>"'`]+/gi
const TRAILING_PUNCTUATION = /[),.:;!?\]}]+$/

export type TerminalHttpLink = { text: string; start: number; end: number }

export function findTerminalHttpLinks(line: string): TerminalHttpLink[] {
  const links: TerminalHttpLink[] = []
  HTTP_URL.lastIndex = 0

  for (let match = HTTP_URL.exec(line); match; match = HTTP_URL.exec(line)) {
    // `https://example.com).` ending a sentence: the closing punctuation is not part of the URL
    const text = match[0].replace(TRAILING_PUNCTUATION, '')
    if (!text) continue
    try {
      const url = new URL(text)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      links.push({ text: url.href, start: match.index, end: match.index + text.length })
    } catch {
      // Not a URL after all: left as plain text
    }
  }
  return links
}

/** A link opens only with a modifier held, as in VS Code's terminal, to prevent misfires */
export function isTerminalLinkActivation(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return event.metaKey || event.ctrlKey
}

/**
 * xterm's per-line link provider. xterm's coordinates are 1-based and the end inclusive; a URL is ASCII, so its code
 * units equal its cells.
 */
export function registerTerminalHttpLinks(term: Terminal, openUrl: (url: string) => void) {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true) ?? ''
      const links = findTerminalHttpLinks(line).map(
        (found): ILink => ({
          text: found.text,
          range: {
            start: { x: found.start + 1, y: bufferLineNumber },
            end: { x: found.end, y: bufferLineNumber },
          },
          decorations: { pointerCursor: true, underline: true },
          activate(event) {
            if (!isTerminalLinkActivation(event)) return
            event.preventDefault()
            // window.open opens nothing in the desktop webview (#159); the platform port opens the system browser
            openUrl(found.text)
          },
          hover() {
            term.element?.setAttribute('title', 'Open link with Command/Ctrl-click')
          },
          leave() {
            term.element?.removeAttribute('title')
          },
        }),
      )
      callback(links.length ? links : undefined)
    },
  }
  return term.registerLinkProvider(provider)
}
