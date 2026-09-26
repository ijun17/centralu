import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

/**
 * 터미널은 셸·자주 쓰는 명령 로그·명령 전용 터미널 세 곳에서 쓰인다. URL을 각 화면이
 * 따로 찾아 열면 한쪽만 VS Code처럼 되고 나머지는 평문으로 남으므로, 링크 판정과 열기를
 * 이 작은 공통 부품 하나에 둔다.
 *
 * `http(s)`만 받는다. 터미널 출력은 신뢰할 수 없는 문자열이므로 `file:`, `javascript:`
 * 같은 스킴까지 클릭 가능한 UI로 만들면 안 된다. 프로젝트 파일은 이미 대화의 FileLink가
 * 읽기 전용 뷰어로 다루는 별개의 길이다.
 */
const HTTP_URL = /https?:\/\/[^\s<>"'`]+/gi
const TRAILING_PUNCTUATION = /[),.:;!?\]}]+$/

export type TerminalHttpLink = { text: string; start: number; end: number }

/** 한 줄의 xterm 출력에서 열 수 있는 URL과 그 문자열 인덱스를 찾는다. */
export function findTerminalHttpLinks(line: string): TerminalHttpLink[] {
  const links: TerminalHttpLink[] = []
  HTTP_URL.lastIndex = 0

  for (let match = HTTP_URL.exec(line); match; match = HTTP_URL.exec(line)) {
    // 문장 끝의 `https://example.com).`에서 닫는 문장 부호는 URL이 아니다.
    const text = match[0].replace(TRAILING_PUNCTUATION, '')
    if (!text) continue
    try {
      const url = new URL(text)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      links.push({ text: url.href, start: match.index, end: match.index + text.length })
    } catch {
      // 정규식 모양만 URL인 깨진 출력은 평문으로 둔다.
    }
  }
  return links
}

/** VS Code terminal과 같이 오동작을 막기 위해 수정 키가 있을 때만 링크를 연다. */
export function isTerminalLinkActivation(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return event.metaKey || event.ctrlKey
}

/**
 * xterm의 한 줄 링크 공급자.
 *
 * xterm buffer 좌표는 1-based이고, 일반 문자열 인덱스는 0-based다. URL은 ASCII라 URL
 * 자체의 code-unit과 터미널 cell 수가 같으며, 범위의 끝도 xterm이 기대하는 inclusive
 * 1-based 좌표(`start + length`)로 바꾼다.
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
            // URL은 위에서 http(s)로 검증했다. 바깥 브라우저로 열어 앱의 현재 작업을 건드리지 않는다.
            // window.open을 직접 부르면 데스크톱 웹뷰에서는 아무것도 열리지 않는다 (#159) —
            // 여는 길은 플랫폼 포트가 안다.
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
