import type { ReadResourceResult } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { viewDocumentFromResource } from '../../views/view-document.js'
import { checkScreen } from './check.js'

/**
 * The app check judges a screen the way the renderer reads it (#850 round 4): it kept its own strict copy of the MIME
 * test and its own reading of the body, so it called screens broken that render (a Python SDK server writes
 * `text/html; profile=mcp-app`), and skipped the page checks of a blob screen the renderer shows.
 */

const URI = 'ui://x/index.html'
const read = (content: Record<string, unknown>) => ({ contents: [{ uri: URI, ...content }] }) as ReadResourceResult
const problems = (r: ReturnType<typeof checkScreen>) => r.findings.filter((f) => f.level === 'problem').map((f) => f.message)

describe('the app check reads a screen as the renderer does', () => {
  it.each(['text/html;profile=mcp-app', 'text/html; profile=mcp-app', 'Text/HTML; Profile=MCP-App'])(
    'a mimeType of %j renders, so it is no problem',
    (mimeType) => {
      const r = read({ mimeType, text: '<p>hi</p>' })
      expect(viewDocumentFromResource(r, URI).html).toBe('<p>hi</p>')
      expect(problems(checkScreen(URI, r))).toEqual([])
    },
  )

  it('plain text/html does not render, and is a problem', () => {
    const r = read({ mimeType: 'text/html', text: '<p>hi</p>' })
    expect(() => viewDocumentFromResource(r, URI)).toThrow(/not an app view/)
    expect(problems(checkScreen(URI, r))).toEqual([
      'its mimeType is "text/html" — a screen must be "text/html;profile=mcp-app" (centralu.uiResource sets it)',
    ])
  })

  it('a blob screen is decoded and its page checked: a page with no bridge is a problem, its size is the page', () => {
    const page = '<script src="centralu:mcp-app.js"></script>'
    const r = read({ mimeType: 'text/html;profile=mcp-app', blob: Buffer.from(page).toString('base64') })
    expect(viewDocumentFromResource(r, URI).html).toBe(page)
    const checked = checkScreen(URI, r)
    expect(problems(checked)).toEqual([
      '<script src="centralu:mcp-app.js"> is still in the page — this screen has no bridge, so it cannot call tools. Register it with centralu.uiResource',
    ])
    expect(checked.findings.filter((f) => f.level === 'warning').map((f) => f.message)).toEqual([
      "the HTML came as a blob, not as text — Centralu's template sends text",
    ])
    expect(checked.chars).toBe(page.length)
  })

  it('an entry with neither text nor a blob cannot be shown, and is a problem', () => {
    const r = read({ mimeType: 'text/html;profile=mcp-app' })
    expect(() => viewDocumentFromResource(r, URI)).toThrow(/neither text nor blob/)
    expect(problems(checkScreen(URI, r))).toEqual(['it has neither text nor a blob, so it cannot be shown'])
  })
})
