/**
 * The app link `centralu://app?url=<address of a folder or zip>` (M4 E-4) — clicking it opens the
 * import confirmation window (E-3) already filled in with that source.
 *
 * A link is **text written by someone else**. Clicking a link in an email, a chat or a web page
 * hands it to this app through the OS. So this file only narrows the shape, and opening only
 * happens after the person clicks Review in the confirmation window (the window never reads or
 * downloads anything up front). The host judges the received source once more by its own rules
 * (`apps/external/imports.ts` `classifySource`) — this file only decides which links the screen
 * is allowed to raise into the window at all.
 *
 * Accepted: exactly one `centralu://app?url=`, whose value is either `https:` (not an address
 * carrying credentials) or a `file:` on this machine. A bare path, http, or any other scheme is
 * rejected. Two `url` values are rejected too, since it would be ambiguous which one to open.
 * Any other, unknown field is not read (a later revision may add to them).
 *
 * This lives here so the screen (UI) and the host can share it — this package is the only shelf
 * both can reach.
 */

export const APP_LINK_MAX_CHARS = 4096

export type AppLinkParse = { ok: true; source: string } | { ok: false; error: string }

export function parseAppLink(link: string): AppLinkParse {
  if (link.length > APP_LINK_MAX_CHARS) return { ok: false, error: `The link is longer than ${APP_LINK_MAX_CHARS} characters` }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(link)) return { ok: false, error: 'The link contains control characters' }
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return { ok: false, error: 'Not a link Centralu understands' }
  }
  if (url.protocol !== 'centralu:') return { ok: false, error: 'Not a centralu:// link' }
  if (url.host !== 'app' || (url.pathname !== '' && url.pathname !== '/')) {
    return { ok: false, error: 'Centralu links open apps: centralu://app?url=…' }
  }
  const values = url.searchParams.getAll('url')
  if (values.length !== 1) return { ok: false, error: values.length ? 'The link names more than one url' : 'The link names no url to import from' }
  const raw = values[0]!
  let inner: URL
  try {
    inner = new URL(raw)
  } catch {
    return { ok: false, error: `Not a link to import from: ${raw}` }
  }
  if (inner.protocol === 'https:') {
    if (inner.username || inner.password) return { ok: false, error: 'Links with a user name or password in them are not accepted' }
    return { ok: true, source: inner.href }
  }
  if (inner.protocol === 'file:') {
    if (inner.host !== '' && inner.host !== 'localhost') return { ok: false, error: 'Only files on this machine can be imported from a file link' }
    return { ok: true, source: inner.href }
  }
  return { ok: false, error: `Only https links and files on this machine can be imported: ${raw}` }
}
