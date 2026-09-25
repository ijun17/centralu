/** `ui://` 읽기 결과 → 화면 문서 (M4 B-3). 무엇이 화면인지는 규격의 MIME 프로필이 정한다 */
import { describe, expect, it } from 'vitest'
import { VIEW_MIME_TYPE, viewDocumentFromResource } from './view-document.js'

const URI = 'ui://notes/board'

describe('viewDocumentFromResource', () => {
  it('text 본문과 _meta.ui의 CSP·권한을 읽는다', () => {
    const doc = viewDocumentFromResource(
      {
        contents: [
          {
            uri: URI,
            mimeType: VIEW_MIME_TYPE,
            text: '<p>hi</p>',
            _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] }, permissions: { camera: {} } } },
          },
        ],
      },
      URI,
    )
    expect(doc).toEqual({ html: '<p>hi</p>', csp: { connectDomains: ['https://api.example.com'] }, permissions: { camera: {} } })
  })

  it('base64 blob 본문도 읽고, MIME 매개변수의 공백·대소문자는 느슨하게 본다', () => {
    const doc = viewDocumentFromResource(
      { contents: [{ uri: URI, mimeType: 'Text/HTML; profile=mcp-app', blob: Buffer.from('<b>한글</b>').toString('base64') }] },
      URI,
    )
    expect(doc.html).toBe('<b>한글</b>')
    expect(doc.csp).toBeUndefined()
  })

  it('여러 항목이면 그 uri의 것을 고른다', () => {
    const doc = viewDocumentFromResource(
      {
        contents: [
          { uri: 'ui://notes/other', mimeType: VIEW_MIME_TYPE, text: 'other' },
          { uri: URI, mimeType: VIEW_MIME_TYPE, text: 'mine' },
        ],
      },
      URI,
    )
    expect(doc.html).toBe('mine')
  })

  it.each([
    ['plain text/html', { contents: [{ uri: URI, mimeType: 'text/html', text: '<p>' }] }, /not an app view/],
    ['no mime', { contents: [{ uri: URI, text: '<p>' }] }, /not an app view/],
    ['json', { contents: [{ uri: URI, mimeType: 'application/json', text: '{}' }] }, /not an app view/],
    ['no body', { contents: [{ uri: URI, mimeType: VIEW_MIME_TYPE }] }, /neither text nor blob/],
    ['no contents', { contents: [] }, /no content/],
    ['not an object', null, /no content/],
  ])('%s는 화면이 아니다', (_label, result, error) => {
    expect(() => viewDocumentFromResource(result, URI)).toThrow(error)
  })
})
