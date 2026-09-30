import { describe, expect, it } from 'vitest'
import { APP_LINK_MAX_CHARS, parseAppLink } from './app-link.js'

/**
 * The app link (M4 E-4) — the door through which text written by someone else reaches the
 * import window. This file only checks the shape: opening it only happens after the person
 * clicks in the window, and the host judges it again by its own rules
 * (`apps/external/imports.test.ts`).
 */
describe('parseAppLink', () => {
  it('extracts an https zip and a file: address on this machine as the source', () => {
    expect(parseAppLink('centralu://app?url=https://example.com/notes.zip')).toEqual({ ok: true, source: 'https://example.com/notes.zip' })
    expect(parseAppLink('centralu://app?url=https%3A%2F%2Fexample.com%2Fa%20b.zip')).toEqual({ ok: true, source: 'https://example.com/a%20b.zip' })
    expect(parseAppLink('centralu://app/?url=file:///Users/me/Downloads/notes.zip')).toEqual({ ok: true, source: 'file:///Users/me/Downloads/notes.zip' })
    // The URL spec empties out localhost — exactly the shape the host's fileURLToPath reads
    expect(parseAppLink('centralu://app?url=file://localhost/tmp/app')).toEqual({ ok: true, source: 'file:///tmp/app' })
    // Unknown fields are not read — a later revision may add to them
    expect(parseAppLink('centralu://app?url=https://example.com/a.zip&from=chat')).toEqual({ ok: true, source: 'https://example.com/a.zip' })
  })

  it('rejects a different scheme, a different path, and a link with no url or two urls', () => {
    for (const [link, error] of [
      ['https://example.com/a.zip', 'Not a centralu:// link'],
      ['centralu://settings?url=https://example.com/a.zip', 'Centralu links open apps: centralu://app?url=…'],
      ['centralu://app/other?url=https://example.com/a.zip', 'Centralu links open apps: centralu://app?url=…'],
      ['centralu://app', 'The link names no url to import from'],
      ['centralu://app?url=https://a.test/1.zip&url=https://b.test/2.zip', 'The link names more than one url'],
      ['not a link', 'Not a link Centralu understands'],
    ] as const) {
      expect(parseAppLink(link), link).toEqual({ ok: false, error })
    }
  })

  it('a source is only https or a file on this machine — rejects http, other schemes, a bare path, an address carrying credentials, and a file: on another machine', () => {
    for (const [inner, error] of [
      ['http://example.com/a.zip', 'Only https links and files on this machine can be imported: http://example.com/a.zip'],
      ['javascript:alert(1)', 'Only https links and files on this machine can be imported: javascript:alert(1)'],
      ['smb://server/share/a.zip', 'Only https links and files on this machine can be imported: smb://server/share/a.zip'],
      ['/Users/me/app', 'Not a link to import from: /Users/me/app'],
      ['https://user:pw@example.com/a.zip', 'Links with a user name or password in them are not accepted'],
      ['file://fileserver/share/a.zip', 'Only files on this machine can be imported from a file link'],
    ] as const) {
      expect(parseAppLink(`centralu://app?url=${encodeURIComponent(inner)}`), inner).toEqual({ ok: false, error })
    }
  })

  it('rejects a link that is too long or contains control characters', () => {
    expect(parseAppLink(`centralu://app?url=https://example.com/${'a'.repeat(APP_LINK_MAX_CHARS)}`)).toEqual({
      ok: false,
      error: `The link is longer than ${APP_LINK_MAX_CHARS} characters`,
    })
    expect(parseAppLink('centralu://app?url=https://example.com/a.zip\n')).toEqual({ ok: false, error: 'The link contains control characters' })
  })
})
