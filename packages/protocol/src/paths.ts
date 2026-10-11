/**
 * How a path is spelled on the wire (issue #47).
 *
 * There are two kinds of path in this app and they are not the same kind of thing:
 *
 *   - A **project-relative** path — the `rel` of every `fs` call, the `path` of an `FsEntry`,
 *     the path git prints, the path a message links to. It is **POSIX-separated, always**,
 *     whatever machine either end is running on.
 *   - A **native** path — a project's directory, and nothing else so far. It is chosen by the
 *     OS folder picker and handed straight back to the OS (a terminal's cwd, a process's cwd,
 *     the file manager). It is never taken apart, and never normalised.
 *
 * The first rule is forced rather than chosen. `packages/ui` is not allowed to know which OS it
 * is on — that is checked, in `tooling/styles.test.ts` — so a relative path that arrived with a
 * native separator would have to be read one way on Windows and another way everywhere else,
 * *in the UI*, which is precisely the branch that rule exists to forbid. Git settles it from the
 * other side too: its own path format is POSIX on every platform, and its output reaches the
 * screen unchanged, so any other choice would mean converting git's answers for nothing.
 *
 * The conversion therefore lives at the host's edge, where a relative path meets a real
 * filesystem, and nowhere else. On macOS and Linux that conversion is the identity — which is
 * exactly why getting it wrong has cost nothing so far, and why it was worth writing down before
 * a platform exists that would notice.
 *
 * **This does not make the app run on Windows (#14).** It makes one assumption a named thing
 * instead of twenty-one anonymous ones, so that when Windows is attempted it fails for reasons
 * that are actually about Windows. `tooling/paths.test.ts` is what keeps the twenty-second from
 * appearing.
 */

/**
 * The segments of a wire path, empty ones included — `a//b` has three, and `/a` has an empty
 * first one, which is how "this is absolute" survives as something a caller can see.
 */
export function wireSegments(path: string): string[] {
  return path.split('/')
}

/**
 * The last non-empty segment of a wire path, or `''` when there is none.
 *
 * Empty segments are dropped so a trailing separator does not turn a name into nothing: `sub/`
 * is still `sub`. This answers "which segment", not "is this a file name" — the host has more to
 * ask before it will treat the answer as a name (see `baseName` in `dev-services/fs.ts`).
 */
export function wireBaseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? ''
}

/**
 * Join wire path parts, dropping the empty ones.
 *
 * The empty part is the project root and it is the common case, so it has to disappear rather
 * than contribute a separator: `wireJoin('', 'a.ts')` is `a.ts`. The alternative, `/a.ts`, is an
 * absolute path, and every check downstream refuses those — the bug would surface as "the root
 * folder is the one place you cannot drop a file".
 */
export function wireJoin(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

/**
 * The last segment of a path that came from the OS, under either separator.
 *
 * This is for the *other* kind of path, and it exists because code without `node:path` sometimes
 * has to read one: the browser mock names a project after its directory, and the real host names
 * it with `basename`. Reading only `/` there is how the two quietly disagree on Windows — the
 * mock would call a project `C:\Users\me\proj` and the host would call it `proj` — and a
 * disagreement that e2e cannot see is the one thing the mock exists to prevent.
 *
 * Both separators are honoured because the string may have come from either kind of machine
 * while the code reading it is on neither. That is not free, and the cost is worth naming: a
 * directory called `a\b` is legal on macOS and Linux, and this would read it as two segments
 * where `node:path.basename` on that machine reads one. The trade is deliberate — being wrong
 * about a directory nobody has costs one display name, and being wrong about every directory on
 * Windows costs the mock the only thing it is for.
 */
export function osPathBaseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? ''
}

/** Reserved device names on Windows, alone or before an extension (`CON`, `con.txt`, `COM1`) */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
/** The longest name most file systems take (255 bytes on ext4 and APFS) */
const MAX_FOLDER_NAME_BYTES = 255

/**
 * Why `name` cannot be a new project's folder name (#515), in one sentence, or null when it can. It is here rather than
 * in the host because the dialog says it as the person types and the mock has to refuse what the host refuses.
 *
 * One path segment only: a name that climbs (`..`) or descends (`a/b`) would put the folder somewhere the card or the
 * dialog did not say. Reserved Windows names are refused on every machine, not only Windows: a project is a folder
 * people copy, sync and clone elsewhere, and a `nul` in it breaks every Windows checkout. The other characters Windows
 * forbids, and a trailing dot or space (which it silently drops, so the folder would not be the name), are refused
 * where the folder is made on Windows.
 */
export function folderNameError(name: string, windows: boolean): string | null {
  if (!name) return 'Give the new folder a name.'
  if (name === '.' || name === '..') return `"${name}" is not a folder name.`
  if (/[/\\]/.test(name)) return 'The name is one folder, without / or \\ in it.'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'The name has a control character in it.'
  if (new TextEncoder().encode(name).length > MAX_FOLDER_NAME_BYTES) return 'The name is too long for a folder.'
  if (WINDOWS_RESERVED_NAME.test(name)) return `"${name}" is a name Windows keeps for a device — choose another.`
  if (windows) {
    if (/[<>:"|?*]/.test(name)) return 'The name has a character Windows does not allow in a folder name (< > : " | ? *).'
    if (/[. ]$/.test(name)) return 'A folder name on Windows cannot end with a dot or a space.'
  }
  return null
}
