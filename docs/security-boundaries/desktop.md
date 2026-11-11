# The desktop: command permissions, project files and images

## Desktop command permissions

Tauri lets a page call our Rust commands over IPC. Until #186, with no app manifest, Tauri let app
commands from **local** origins (the dev server, `tauri://localhost`, registered custom schemes)
through without a permission check (tauri 2.11.5 `webview/mod.rs` `on_message`); only a per-launch
invoke key stood in the way. Remote origins, a loopback app frame among them, were already refused
(tauri ≥ 2.11.1).

Now `apps/desktop/src-tauri/build.rs` declares an app manifest, which creates a permission per
command (`allow-<command>`), and `capabilities/default.json` grants the 19 commands **only to the
window `main` on local origins**: no `remote`, no wildcard window. The granted set is exactly what
the frontend calls. `tooling/desktop-permissions.test.ts` holds the manifest, the `invoke_handler`,
the grants and the call sites to each other, and fails on `remote` or a wildcard. Plugin
permissions have no call site to hold them to, so the test names every one that is granted: adding
a plugin, or widening one, is a change to that list. The one widening so far is a scoped `opener:allow-open-url` for
`vscode://vscode-remote/ssh-remote+*` (VS Code's Remote-SSH links for a linked machine's project, #82); the test holds
it to that one pattern. It also holds the app-link setup (M4 E-4) to
one URL scheme, `centralu`, and no deep-link plugin.

Measured on a real Tauri instance (#186, when there were 12; `take_app_links` came with app links,
M4 E-4, and the five keeper commands came with #280 — `host_build`, `switch_host_build` (gone with #1895 step 4 PR 3), `background_mode`,
`set_background_mode`, `quit_and_stop_agents` — and none of those has been measured this way): all 12 answer from the main page, in dev and in a
`tauri://localhost` debug build. From an app frame holding a leaked invoke key, 60 of 60 calls were
refused by the permission check and none reached a handler.

Limits:

- Tauri writes the real invoke key to stderr every time a wrong key arrives. Nothing in our
  pipeline collects Tauri's own stderr (`host.log` holds the host's stderr; the release app's
  stderr goes to `/dev/null`). Whatever starts collecting it must keep it on the machine.
- A frame on a **local** origin inside the main window has our UI's origin, so permissions cannot
  tell it apart. The rule that covers it: never serve app content from a local origin (the dev
  server's port, `tauri://`, custom schemes). Only review keeps a future change from breaking it.
- A `remote` capability covering 127.0.0.1 would open our commands to app views. Do not add one.

## Project files and native handoff

Existing filesystem targets are checked against the canonical project root. Symlinks
resolving inside that root are supported; outside targets and dangling links are rejected.
Text/image reads require a regular-file descriptor, bound allocation/read size, and compare
opened-file identity. Native reveal/trash checks are additional absolute/no-symlink checks;
they are **not** independent proof of project containment. What the host hands them depends on what it is for
(`fs.resolve`'s `purpose`, #838). For the **trash** it is the entry itself (`resolveEntry`): the folder it sits in is
resolved, the last segment is taken as it is, a link included, and the project folder is refused; the shell's trash
check (`assert_safe_native_entry`) allows a link only as that last segment, and the `trash` crate canonicalizes only the
parent, so a link is trashed as the link. For **reveal** and **open in an IDE** it is what the entry is
(`resolveTarget`): a link is followed, its target checked inside the project, and the project folder refused. Before,
both followed the last link, so an untrusted repository's `old-build -> .` sent the project folder to the trash. The
project folder itself goes to the trash through one door only, "Delete project and trash folder"
(`trashProjectFolder`, `purpose: 'project'`, which takes no path). A window from before this change sends no purpose
and gets `resolveTarget`: the project folder is refused, except as the literal root (`.`) its delete dialog sends, and
a link to something else inside the project is still trashed as its target until the window is updated. The shell
also refuses a path that ends in a separator or `.`, which its component check would otherwise drop (`link/`). Opening in an IDE does not fall
back to a generic OS opener that could execute repository-authored content. A linked machine's project is opened
with a VS Code Remote-SSH link instead (#82): VS Code connects over the person's ssh and, by default, asks before opening a remote file
or folder from a link (`security.promptForRemoteFileProtocolHandling`); the hub hands it a path and never reads or runs the file itself.

A worktree session's file links (#1209) name the session: `fs.readFile` and `fs.resolve` with a `sessionId` take that
session's folder as the root instead of the project's (its worktree, or the project when it has none), and every check
above runs against that root. The host builds the root from its own record of the session, never from a path the window
sends, and hands the same string to the containment check and to the read (`ProjectFiles.folderOf`, `dev-services/project-files.ts`). A session of
another project is refused, so a project id cannot carry a stranger's folder, and a path outside the worktree is refused
like one outside the project, the main checkout included. A session's folder is only read, revealed and opened: `trash`
and `project` with a `sessionId` are refused.

Limits:

- An in-root hardlink shares an inode with its other names. Canonical pathname checks do
  not establish where that inode originated, so they do not close hardlink-based access.
- Validation and OS pathname use are separate operations. Same-user replacement races
  remain, especially for move/import/list/watch and native handoff. Descriptor identity
  checks narrow the read window but are not an atomic descriptor-relative filesystem sandbox.
- Project containment does not confine provider tools or terminal commands intentionally
  executed with the user's permissions. Approval policy and OS isolation are separate layers.

Do not expand the scope of these claims without stronger implementation and platform-level
validation. In particular, do not describe these checks as complete filesystem isolation.

## Images a reply names

An agent often answers with a screenshot it saved: `![grid](/Users/me/Desktop/run/.test/r1/grid.png)`. The window
cannot load that path itself (its origin is the app, and the desktop CSP's `img-src` is `'self' data: blob:`), so
WKWebView drew a broken-image mark. The owner chose (2026-10-07) to show such an image **wherever it is on disk**, so
the window asks the session's host for it (`messages.image`, [protocol.md](../protocol.md) §3) and draws the bytes as a
`data:` URL. The CSP is unchanged: a web image in a reply stays an ordinary `<img>`, and whether it loads is the CSP's
answer, as before.

Since the file can be anywhere, the project root is not the boundary here. Three checks are, each on its own
(`dev-services/message-image.ts`, `SessionRecord.messageImage`):

- **Only a path this session's replies wrote.** The host looks for the path in the session's own stored replies
  (`assistant` `text` rows, its subagents' included) and in the reply still streaming. The person's messages, reasoning
  and tool output do not count, and neither does another session's reply. The match must stand alone, bounded by
  space, a bracket or a quote, so a reply that wrote `/x/a.png` does not admit `a.png` (which resolves against the
  session's folder to a different file). This is asked before the path is resolved or anything on disk is touched: a
  refused path learns nothing about whether it exists. Without it, whoever holds the WebSocket token could read any
  image on the machine through this call.
- **Only a real image, by its bytes.** PNG, JPEG, GIF or WebP by their signatures, whatever the name says. A text file
  named `.png`, or a link named `.png` that points at one, is refused, and its contents are not sent. SVG is refused:
  it has no signature, so accepting it would mean accepting any text file that contains `<svg`, and it is a document
  that can carry script and external references, which the window would be taking on the strength of an agent's
  sentence (`<img>` does not run them, but nothing here needs it to). The project file viewer still shows a project's
  SVGs.
- **At most 10 MB** (10 MiB, `IMAGE_PREVIEW_MAX_BYTES`, shared with the file viewer's preview), checked on the opened file
  and again on what was read, so a file that grows between the two is still refused.
- **Only this machine.** A `file://` URL that names another host is refused, and on Windows so is any path that
  resolves to `\\…`: a UNC share (`\\server\share`, `//server/share`, and `file://server/share`, which Node turns into
  that UNC path on Windows rather than refusing it) or a `\\?\` / `\\.\` device path. Reading one would have the host
  reach out to whichever machine a reply named, and Windows offers that machine the person's sign-in. This is decided
  on the resolved path, so a relative path in a session whose folder is a share is refused too. A local link that leads
  there (`shot.png -> \\host\share\x.png`, or a folder link earlier in the path) is refused as well, before `realpath`
  follows it, since following it is already the connection. On Windows the path is walked from its drive (`link-walk.ts` `walkLinks`,
  #849): what each name is comes from its folder's listing (`lstat` follows a link whose target libuv cannot read),
  and a link is followed by hand only when its target is a drive path or relative to the link's folder
  (`localLinkTarget`). Any other target is refused, the NT spellings of a share (`\Device\Mup\…`, `\GLOBAL??\UNC\…`)
  included, and so is a link whose target cannot be read (a junction to a volume with no drive letter), a name its
  folder does not list and that names none of its entries (a trailing dot or space, a stream), and more than 64 links.
  A short name (`RUNNER~1`, how a temp folder or a link's target may be spelled) is matched to the entry it names by
  file identity from `lstat`, which does not follow a link, and that entry is judged as itself: a short name of a link
  to a share is that link, refused. What `realpath` answers must be a drive path too. A
  drive letter mapped to a share is read like any other drive: the person mapped it.

The path is resolved once (`~`, a path relative to the session's folder, a `file://` URL, then `realpath`), and that
resolved string is the one opened, with `O_NOFOLLOW`, once; the type, the size and the signature are all read through
that one descriptor. A refusal comes back as an answer with its reason (not mentioned, not found, not an image, too
large, unreadable), shown in the picture's place with the path the reply wrote. When there is a file there, the answer
carries its resolved path, and the window offers to reveal it in the file manager through the shell's `reveal_path`,
which still refuses a relative path or one with a link in it. For a session on a linked machine the hub drops that path
from the answer (`links/routes.ts`) and the window offers no reveal: the file is on the other machine.

Limits:

- **What the agent writes decides what is shown.** Text an agent read (a web page, a repository file) can steer it into
  naming any image on the machine. The image is then shown to the person in the window and sent nowhere else; the
  agent's own tools could already read the same file with the person's permissions. The checks keep the call from being
  a general file reader, not an agent from pointing at a picture.
- **macOS asks per protected folder.** Reading a file under Desktop, Documents or Downloads is the host reading it, and
  macOS may ask once for that folder in Centralu's name, as it does when a project is there.
- **Same-user races** remain as in "Project files and native handoff": a directory along the path can be swapped
  between `realpath` and `open`. What is read is still checked as an image under the cap, through one descriptor.
