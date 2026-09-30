/** `ui://` read result → view document (M4 B-3). What counts as a view is decided by the spec's MIME profile. */
import { describe, expect, it } from 'vitest'
import { VIEW_MIME_TYPE, viewDocumentFromResource } from './view-document.js'

const URI = 'ui://notes/board'

describe('viewDocumentFromResource', () => {
  it('reads the text body and the CSP and permissions from _meta.ui', () => {
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

  it('also reads a base64 blob body, and is lenient about whitespace and case in the MIME parameter', () => {
    const doc = viewDocumentFromResource(
      { contents: [{ uri: URI, mimeType: 'Text/HTML; profile=mcp-app', blob: Buffer.from('<b>한글</b>').toString('base64') }] },
      URI,
    )
    expect(doc.html).toBe('<b>한글</b>')
    expect(doc.csp).toBeUndefined()
  })

  it('picks the entry for that uri when there are several', () => {
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
  ])('%s is not a view', (_label, result, error) => {
    expect(() => viewDocumentFromResource(result, URI)).toThrow(error)
  })
})
