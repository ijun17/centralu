import { describe, expect, it } from 'vitest'
import { APP_DRAG_NOTIFICATION } from '@cc/protocol'
import { DRAG_RELAY_SCRIPT, withDragRelay } from './drag-relay.js'

const TAG = `<script>${DRAG_RELAY_SCRIPT}</script>`

describe('the drag relay added to a view (#308)', () => {
  it('goes in before the last </body>, so it runs inside the page', () => {
    expect(withDragRelay('<!doctype html><html><body><p>a</p></body></html>')).toBe(`<!doctype html><html><body><p>a</p>${TAG}</body></html>`)
    // The last one: a `</body>` inside the app's own script text comes earlier
    expect(withDragRelay('<body><script>s = "</BODY>"</script></BODY>')).toBe(`<body><script>s = "</BODY>"</script>${TAG}</BODY>`)
  })

  it('goes at the very end of a document with no </body>, never before its doctype', () => {
    const html = '<!doctype html><p>board</p>'
    const out = withDragRelay(html)
    expect(out).toBe(`${html}${TAG}`)
    expect(out.startsWith('<!doctype html>')).toBe(true)
  })

  it('posts the shared notification, reading only the two standard types', () => {
    expect(DRAG_RELAY_SCRIPT).toContain(JSON.stringify(APP_DRAG_NOTIFICATION))
    expect(DRAG_RELAY_SCRIPT).toContain("'text/uri-list'")
    expect(DRAG_RELAY_SCRIPT).toContain("'text/plain'")
    // Kept to what any page can run: no module syntax, no arrow functions
    expect(DRAG_RELAY_SCRIPT).not.toMatch(/=>|\bimport\b|\bexport\b/)
  })
})
