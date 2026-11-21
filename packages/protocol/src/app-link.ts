// `centralu://app?url=…` opens the import dialog (docs/apps/handing-over.md "App links"). A link is someone else's
// text: this only decides which links may raise the dialog; the host judges the source again (`classifySource`).
// Two `url`s are ambiguous and refused; other fields are not read, so a later build may add some.

export const APP_LINK_MAX_CHARS = 4096

export type AppLinkParse = { ok: true; source: string } | { ok: false; error: string }

export function parseAppLink(link: string): AppLinkParse {
  if (link.length > APP_LINK_MAX_CHARS)
    return { ok: false, error: `The link is longer than ${APP_LINK_MAX_CHARS} characters` }
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
  const [raw, ...more] = url.searchParams.getAll('url')
  if (raw === undefined) return { ok: false, error: 'The link names no url to import from' }
  if (more.length > 0) return { ok: false, error: 'The link names more than one url' }
  let inner: URL
  try {
    inner = new URL(raw)
  } catch {
    return { ok: false, error: `Not a link to import from: ${raw}` }
  }
  if (inner.protocol === 'https:') {
    if (inner.username || inner.password)
      return { ok: false, error: 'Links with a user name or password in them are not accepted' }
    return { ok: true, source: inner.href }
  }
  if (inner.protocol === 'file:') {
    if (inner.host !== '' && inner.host !== 'localhost')
      return { ok: false, error: 'Only files on this machine can be imported from a file link' }
    return { ok: true, source: inner.href }
  }
  return { ok: false, error: `Only https links and files on this machine can be imported: ${raw}` }
}
