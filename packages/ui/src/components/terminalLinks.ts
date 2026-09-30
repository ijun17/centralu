import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

/**
 * The terminal is used in three places: the shell, the frequently-used-command log, and a
 * command-dedicated terminal. If each screen found and opened URLs on its own, one would end up
 * looking like VS Code and the rest would stay plain text, so link detection and opening live in
 * this one small shared piece instead.
 *
 * Only `http(s)` is accepted. Terminal output is an untrusted string, so a scheme like `file:` or
 * `javascript:` must not be turned into clickable UI. A project file is already a separate path,
 * handled by the conversation's FileLink as a read-only viewer.
 */
const HTTP_URL = /https?:\/\/[^\s<>"'`]+/gi
const TRAILING_PUNCTUATION = /[),.:;!?\]}]+$/

export type TerminalHttpLink = { text: string; start: number; end: number }

/** Finds the openable URLs in one line of xterm output, along with their string indexes. */
export function findTerminalHttpLinks(line: string): TerminalHttpLink[] {
  const links: TerminalHttpLink[] = []
  HTTP_URL.lastIndex = 0

  for (let match = HTTP_URL.exec(line); match; match = HTTP_URL.exec(line)) {
    // In `https://example.com).` at the end of a sentence, the closing punctuation is not part of the URL.
    const text = match[0].replace(TRAILING_PUNCTUATION, '')
    if (!text) continue
    try {
      const url = new URL(text)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      links.push({ text: url.href, start: match.index, end: match.index + text.length })
    } catch {
      // Broken output that only looks like a URL by regex shape is left as plain text.
    }
  }
  return links
}

/** Only opens a link when a modifier key is held, matching VS Code's terminal, to prevent misfires. */
export function isTerminalLinkActivation(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return event.metaKey || event.ctrlKey
}

/**
 * xterm's per-line link provider.
 *
 * xterm buffer coordinates are 1-based, while ordinary string indexes are 0-based. Since a URL
 * is ASCII, the number of code units in the URL itself equals the number of terminal cells, and
 * the end of the range is also converted to the inclusive 1-based coordinate xterm expects
 * (`start + length`).
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
            // The URL was already validated as http(s) above. Opens in an outside browser so it
            // does not disturb the app's current work.
            // Calling window.open directly opens nothing in the desktop webview (#159) — the
            // platform port knows the way to open it.
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
