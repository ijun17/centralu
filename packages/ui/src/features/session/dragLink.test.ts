import { describe, expect, it } from 'vitest'
import { INTERNAL_DRAG_MIME } from '../files/dragPath.js'
import { appReachNotice } from './appReachNotice.js'
import { droppedPiece, droppedText, insertAtCaret, isOutsideLink, isTextDrag, markdownLink } from './dragLink.js'

const ISSUE = 'https://github.com/ijun17/centralu/issues/306'

describe('what a dropped link or text becomes (#308)', () => {
  it('a link with a one-line title becomes a Markdown link with that title', () => {
    const d = droppedText(ISSUE, '#306 App panels too narrow')
    expect(d).toEqual({ kind: 'link', url: ISSUE, title: '#306 App panels too narrow' })
    expect(droppedPiece(d!)).toBe(`[#306 App panels too narrow](${ISSUE})`)
  })

  it('the address stands as its own title when the text is several lines, empty, or the address itself', () => {
    expect(droppedText(ISSUE, 'first line\nsecond line')).toEqual({ kind: 'link', url: ISSUE, title: ISSUE })
    expect(droppedText(ISSUE, '')).toEqual({ kind: 'link', url: ISSUE, title: ISSUE })
    expect(droppedText(ISSUE, ISSUE)).toEqual({ kind: 'link', url: ISSUE, title: ISSUE })
  })

  it('reads the first address of a uri-list, past comments and blank lines', () => {
    expect(droppedText(`# from the board\r\n\r\n${ISSUE}\r\nhttps://example.test/other`, 't')).toMatchObject({ url: ISSUE })
  })

  it('a lone address in text/plain is a link; any other text goes in as it is', () => {
    expect(droppedText('', `  ${ISSUE}  `)).toEqual({ kind: 'link', url: ISSUE, title: ISSUE })
    expect(droppedText('', 'some selected words\nacross lines')).toEqual({ kind: 'text', text: 'some selected words\nacross lines' })
    expect(droppedText('', '   ')).toBeNull()
  })

  it('only web and mail addresses become links: a blob, data, file or script address does not', () => {
    for (const uri of ['blob:http://127.0.0.1/abc', 'data:image/png;base64,AAAA', 'file:///etc/hosts', 'javascript:alert(1)']) {
      expect(droppedText(uri, ''), uri).toBeNull()
      expect(droppedText(uri, 'a title'), uri).toEqual({ kind: 'text', text: 'a title' })
    }
    expect(droppedText('mailto:a@example.test', 'Mail A')).toEqual({ kind: 'link', url: 'mailto:a@example.test', title: 'Mail A' })
  })

  it('a Markdown link survives brackets in the title and parentheses or spaces in the address', () => {
    expect(markdownLink('[x] done \\ ok', 'https://e.test/a (b)')).toBe('[\\[x\\] done \\\\ ok](https://e.test/a%20%28b%29)')
    expect(markdownLink('  two\t words  ', 'https://e.test/')).toBe('[two words](https://e.test/)')
  })
})

describe('where it goes: at the caret', () => {
  it('replaces the selection, with a space where it would touch a word', () => {
    expect(insertAtCaret('see  for details', 4, 4, '[L](u)')).toEqual({ text: 'see [L](u) for details', caret: 10 })
    expect(insertAtCaret('seeXfor', 3, 4, '[L](u)')).toEqual({ text: 'see [L](u) for', caret: 11 })
  })

  it('at the end of the text it leaves a space after, so typing goes on; into an empty composer too', () => {
    expect(insertAtCaret('look at', 7, 7, '[L](u)')).toEqual({ text: 'look at [L](u) ', caret: 15 })
    expect(insertAtCaret('', 0, 0, '[L](u)')).toEqual({ text: '[L](u) ', caret: 7 })
  })

  it('keeps a caret past the end inside the text', () => {
    expect(insertAtCaret('ab', 9, 12, 'X')).toEqual({ text: 'ab X ', caret: 5 })
  })
})

describe('which drags the composer and the pane take', () => {
  it('the composer takes a link or text, and leaves a session, panel or path drag to its owner (#286)', () => {
    expect(isTextDrag(['text/uri-list', 'text/plain'])).toBe(true)
    expect(isTextDrag(['text/plain', INTERNAL_DRAG_MIME])).toBe(true)
    expect(isTextDrag(['application/x-cc-session', 'text/plain', INTERNAL_DRAG_MIME])).toBe(false)
    expect(isTextDrag(['application/x-cc-path', 'text/plain'])).toBe(false)
    expect(isTextDrag(['Files'])).toBe(false)
  })

  it('the pane takes only a link from outside the window, never one dragged inside it or an OS file', () => {
    expect(isOutsideLink(['text/uri-list', 'text/plain'])).toBe(true)
    expect(isOutsideLink(['text/uri-list', 'text/plain', INTERNAL_DRAG_MIME])).toBe(false)
    expect(isOutsideLink(['Files', 'text/uri-list'])).toBe(false)
    expect(isOutsideLink(['text/plain'])).toBe(false)
  })
})

describe('the line under a link from an app the session cannot reach', () => {
  it('names the app and says what would fix it, for each reason', () => {
    const say = (r: Parameters<typeof appReachNotice>[0], project: string | null = 'alpha') => appReachNotice(r, 'Project board', project)
    expect(say({ reachable: false, reason: 'other-project' })).toBe(
      "This session can't use Project board's tools: the app belongs to alpha. Ask in a session of alpha to use them.",
    )
    expect(say({ reachable: false, reason: 'other-project' }, null)).toMatch(/one of your apps, which only the orchestrator can use/)
    expect(say({ reachable: false, reason: 'untrusted' })).toMatch(/alpha is not trusted\. Trust the project/)
    expect(say({ reachable: false, reason: 'app-unusable', status: 'failed' })).toMatch(/Restart it from its view/)
    expect(say({ reachable: false, reason: 'app-unusable', status: 'unconfirmed' })).toMatch(/not turned on yet/)
    expect(say({ reachable: false, reason: 'app-unusable', status: 'invalid' })).toMatch(/manifest is not valid/)
    expect(say({ reachable: false, reason: 'restart' })).toMatch(/Codex thread started before the app was attached\. Restart the session/)
    expect(say({ reachable: false, reason: 'bridge-failed' })).toMatch(/bridge did not start in this session\. Restart the session/)
    expect(say({ reachable: false, reason: 'unavailable' })).toMatch(/not available/)
  })
})
