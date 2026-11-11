# Windows (#14)

Nothing here has been run on a Windows machine by a person yet; the Windows CI job runs the unit
tests. What differs from macOS and Linux, and what holds it:

- **Programs run by name in a project.** Given a bare name, Windows process creation looks in the
  child's working directory before PATH. Every git call runs in the project, so a `git.exe`
  committed at a repository's root would run on the first status read. `git`, `gh` and an app's
  manifest command are spawned by the absolute path found on PATH (`tool-launch.ts` `programPath`,
  `resolveCommand`; tests in `tool-launch.test.ts`). A program not on PATH at all is never spawned by its bare
  name either: `git`, `gh`, `codex` and `claude` are then a path under `%SystemRoot%\System32` that only an
  administrator can make (`notOnPath`, `toolCommand`), so the spawn reports the tool missing. The bare name had been
  the answer there, and on a machine without git, gh or codex a `git.exe`, `gh.exe` or `codex.exe` committed to a
  project ran on its first status read, pull request look or listing of past Codex conversations, before any trust
  (#838; `git-exec.test.ts`, `git-pr.test.ts`, `codex/not-installed.test.ts` plant one). PATH lookups skip relative entries
  (`env-path.ts`, and `node`/`code` in the Rust shell), and are otherwise no narrower than Windows' own search, so a
  tool it would start is found: a quoted entry is read without its quotes, and an App Execution Alias counts as there
  (`env-path.test.ts`). `du`, which sized the copy candidates by
  bare name with the project as its folder, is not run on Windows at all: the sizes are read from
  the file system there (`traitsFor().measuresWithDu`, #849; `git.test.ts` plants a `du.exe`).
- **System programs by their whole path.** taskkill, Windows PowerShell and cmd.exe are named under
  `%SystemRoot%\System32` (`os.ts` `systemTool`, `commandInterpreter`; `%ComSpec%` for cmd). A `SystemRoot` or
  `ComSpec` that is not a whole path from a drive's root (empty, relative, drive-relative like `C:x`, rooted without
  a drive) is not used and `C:\Windows` is (#428): an empty `SystemRoot` made taskkill's path
  `System32\taskkill.exe`, which Windows looks up in the working directory, the project's folder (`os.test.ts`).
  The remote installer, which runs on its own on a linked Windows machine, names its `tar.exe` by the same rule
  (`links/remote-install.mjs` `tarProgram`, `install.test.ts`).
- **Tool shims are read, not shelled.** npm and pnpm install a tool as a `.cmd` file, which Node
  starts only through `cmd.exe`, and cmd.exe would read `%`, `^`, `&` and quotes in our arguments
  (JSON, prompts) as its own syntax. The shim is read for the `.js` or `.exe` it starts, and that
  is spawned without a shell. Project commands (the Run button) do run under `cmd.exe /d /s /c`,
  because the command is the person's own text.
- **Paths.** `path-guard.ts` refuses a path whose `relative()` from the root is absolute (another
  drive, a UNC share), instead of walking its segments inside the root (`path-guard.test.ts`, with
  `path.win32`). A link along the path is not followed to see whether it stays inside before the walk of
  `link-walk.ts` (the one a reply's image takes) has read where it leads: a symlink to a share (`docs -> \\host\share`),
  or a chain of local links ending in one, is refused unread, since `realpath` following it is already the SMB
  connection with the person's sign-in offered; the guard used to refuse it only afterwards, as outside the project
  (`path-guard-share.test.ts`). A project that is itself on a share (opened from one, a mapped drive, `\\wsl.localhost`)
  keeps its links on that one share: they are followed, and a link to another host or share is refused. Windows paths ignore case; containment folds case as NTFS does (`foldCase`). Every
  "inside" test in the host is `isInside` in `os/rules.ts` (`path-guard.ts` `isInside` is that rule for a given path style: NTFS's case folding, which keeps the Kelvin sign apart from `k`), and every comparison that must see one
  place in two spellings canonicalizes with `canonicalPath` there (`realpathSync.native`: the long name
  for a short one, the case on disk, a link resolved, through the nearest folder that exists; #428). The
  copies had drifted: ask_project's read grants compared with case and the JS `realpath`, so a short
  name or another case was refused, and a touched file under a project kept through a link was dropped.
- **Names that are not file names.** A file dragged into the tree (`importFile`) is refused on
  Windows when Windows would not make a file of that name, by the rules a new project folder's
  name follows (`folderNameError`). Node writes through `\\?\` paths, so a device name (`nul`,
  `aux.c`, `nul .txt`) or a name with a trailing dot or space lands as a file of that very name, which
  Explorer, cmd and git read as the device or as another name and cannot open or remove; and
  `notes.txt:payload` writes a hidden stream on `notes.txt` past the no-overwrite flag (#849).
- **File identity.** A read's opened-file check is the only guard against a swap there, since
  Windows has no `O_NOFOLLOW`. An NTFS file id is 64 bits with the record's reuse count on top, so
  it is above 2^53, and as a Number two files can compare equal: on windows-2022, 1754 of 2000
  pairs of files made one after the other did. `dev` and `ino` are compared as bigints
  (`path-guard.ts` `assertExistingPath`, `fs.ts`; `fs-read-identity.test.ts`, #368).

Limits:

- The files written `0600` here (`app-secrets.json`, `app-imports.json`) get no mode on Windows,
  which has no mode bits; they are as private as the folder they are in. The default data folder
  is in the user's profile, which only that user (and administrators) can read. A `CC_DATA_DIR`
  elsewhere gets that folder's ACL.
- Junctions are reported as links by `lstat` and so are treated like symlinks, except one whose target
  libuv cannot read (a volume path, `\\?\Volume{…}\…`, which anyone can make): `lstat` follows that one and calls it a
  folder, so the worktree copy and the reply-image walk ask the folder's listing instead, and the path guard checks
  where every entry `lstat` does not call a link really is (`realpath`), which has to be inside the project too. It
  had walked on inside such a junction as if it were the project: the file tree listed the folder it led to and a
  dropped file was written there (`path-guard.test.ts`, also by a short name and another case). Creating a symlink on
  Windows needs Developer Mode or administrator rights; a junction does not.
- The keeper does not run on Windows (no named-pipe control socket), so the direct path is used.
