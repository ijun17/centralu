// How a path is spelled on the wire: project-relative paths are POSIX always, native ones are never taken apart
// (docs/protocol.md §3.1).

/** Empty segments included: `/a` has an empty first one, so "absolute" stays visible to a caller */
export function wireSegments(path: string): string[] {
  return path.split('/')
}

/**
 * `sub/` is still `sub`. This answers "which segment", not "is this a file name": the host asks more before it
 * treats the answer as a name (`baseName` in `dev-services/fs.ts`)
 */
export function wireBaseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? ''
}

/** A path with no separator, or the root, is in `''`: the root, as `listDir` writes it */
export function wireParent(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/** The empty part (the root) must vanish: `/a.ts` would be absolute, which every check downstream refuses */
export function wireJoin(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

/**
 * The last segment of a native path, under either separator, for code without `node:path` (the mock names a project
 * as the host's `basename` does, on Windows too). Reads a legal macOS/Linux directory `a\b` as two segments: a wrong
 * display name for a folder nobody has, against the mock disagreeing with the host on every Windows path.
 */
export function osPathBaseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? ''
}

export const MAX_GIT_URL_LENGTH = 2048

/**
 * Why `url` cannot be cloned (#515, owner decision), or null; shared so host, dialog and mock refuse alike. Only https,
 * ssh and scp-like addresses: a `<transport>::` helper runs a command, `file://` and local paths let an agent copy the
 * person's folder in, `git://`/`http://` are unauthenticated, a leading `-` reads as an option, and a password would be
 * kept in `.git/config` and shown on the card.
 */
export function gitSourceError(url: string): string | null {
  const u = url.trim()
  if (!u) return 'Give the address of the repository to clone.'
  if (u.length > MAX_GIT_URL_LENGTH) return 'The repository address is too long.'
  // Before the space check: a helper's address is a command line, and this sentence says why it is refused
  if (u.includes('::'))
    return 'Transport helpers such as ext:: are not cloned — give an https:// or ssh address.'
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(u))
    return 'The repository address has a space or a control character in it.'
  if (u.startsWith('-')) return 'A repository address cannot start with "-".'
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(u)?.[1]?.toLowerCase()
  if (scheme) {
    if (scheme !== 'https' && scheme !== 'ssh') {
      return `${scheme}:// addresses are not cloned — only https://, ssh:// and user@host:path.`
    }
    let parsed: URL
    try {
      parsed = new URL(u)
    } catch {
      return 'That is not a repository address.'
    }
    if (!parsed.hostname || parsed.hostname.startsWith('-') || parsed.username.startsWith('-'))
      return 'The repository address names no host.'
    if (parsed.password)
      return 'Leave the password out of the address — the machine’s own saved sign-in is used.'
    if (parsed.pathname.replace(/\/+/g, '') === '') return 'The repository address names no repository.'
    return null
  }
  // scp-like: [user@]host:path, where the host has no slash and is not a Windows drive letter
  const scp = /^(?:[A-Za-z0-9._~-]+@)?([A-Za-z0-9.-]+):(.+)$/.exec(u)
  const [, scpHost, scpPath] = scp ?? []
  if (
    scpHost !== undefined &&
    scpPath !== undefined &&
    scpHost.length > 1 &&
    !scpHost.startsWith('-') &&
    !scpPath.startsWith('-')
  )
    return null
  return 'A local folder is not cloned — give an https://, ssh:// or user@host:path address.'
}

/**
 * One key per repository however its address is written (`git@GitHub.com:me/app.git` = `github.com/me/app`), so a
 * linked machine finds a checkout of the caller's (#1038). The path keeps its case: a host may tell `Me/App` from
 * `me/app`. Null for a local path or `file://`: a folder names a repository only on its own computer.
 */
export function gitRemoteKey(url: string): string | null {
  let u = url.trim()
  if (!u) return null
  u = u
    .replace(/[?#].*$/, '')
    .replace(/[/\\]+$/, '')
    .replace(/\.git$/i, '')
    .replace(/[/\\]+$/, '')
  const [, schemeName, rest] = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(u) ?? []
  let host: string
  let path: string
  if (schemeName !== undefined && rest !== undefined) {
    if (schemeName.toLowerCase() === 'file') return null
    // [user[:password]@]host[:port]/path
    const slash = rest.indexOf('/')
    const authority = slash < 0 ? rest : rest.slice(0, slash)
    host = authority.replace(/^.*@/, '').replace(/:\d*$/, '')
    path = slash < 0 ? '' : rest.slice(slash + 1)
  } else {
    // scp-like [user@]host:path, where the host is more than a Windows drive letter; anything else is a local path
    const [, scpHost, scpPath] = /^(?:[^@/\\]+@)?([A-Za-z0-9.-]{2,}):(?![/\\]{2})(.+)$/.exec(u) ?? []
    if (scpHost === undefined || scpPath === undefined) return null
    host = scpHost
    path = scpPath
  }
  path = path
    .replace(/\\/g, '/')
    .replace(/^~\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
  if (!host || !path) return null
  return `${host.toLowerCase()}/${path}`
}

/** The folder name a clone of `url` gets by default */
export function repoNameOf(url: string): string {
  const path = url
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/[/\\]+$/, '')
    .replace(/\.git$/i, '')
  return path.split(/[/:\\]/).pop() ?? ''
}

/** Windows device names, also before an extension or spaces (`nul .txt`: Windows drops the spaces), and `CONIN$`/`CONOUT$` (#849) */
const WINDOWS_RESERVED_NAME = /^(?:(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(\..*)?|conin\$|conout\$)$/i
/** 255 bytes on ext4 and APFS */
const MAX_FOLDER_NAME_BYTES = 255

/**
 * Why `name` cannot be a new project's folder name, or null; shared so the dialog and the mock refuse what the host does.
 * Reserved Windows names are refused everywhere: a project folder gets copied to Windows, where a `nul` breaks the
 * checkout. A trailing dot or space is refused on Windows, which drops it silently.
 */
export function folderNameError(name: string, windows: boolean): string | null {
  if (!name) return 'Give the new folder a name.'
  if (name === '.' || name === '..') return `"${name}" is not a folder name.`
  if (/[/\\]/.test(name)) return 'The name is one folder, without / or \\ in it.'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'The name has a control character in it.'
  if (new TextEncoder().encode(name).length > MAX_FOLDER_NAME_BYTES)
    return 'The name is too long for a folder.'
  if (WINDOWS_RESERVED_NAME.test(name))
    return `"${name}" is a name Windows keeps for a device — choose another.`
  if (windows) {
    if (/[<>:"|?*]/.test(name))
      return 'The name has a character Windows does not allow in a folder name (< > : " | ? *).'
    if (/[. ]$/.test(name)) return 'A folder name on Windows cannot end with a dot or a space.'
  }
  return null
}
