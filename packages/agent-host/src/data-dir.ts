import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DATA_DIR, DATA_DIR_DEV } from '@cc/protocol'
import { HOST_PLATFORM, modesGuardFiles, type Platform } from './os.js'
import { canonicalPath } from './dev-services/path-guard.js'

/**
 * The root of the data folder — attachments, the orchestrator home, and worktrees all live under
 * this.
 *
 * **Why it can be overridden by an environment variable:** otherwise tests would write into the
 * user's real home.
 *
 * At startup, the host pins this value as its own data folder (dev and prod diverge here).
 */
export function dataRoot(): string {
  return process.env.CC_DATA_DIR || join(homedir(), DATA_DIR)
}

/**
 * Which folder this host keeps its data in (#973).
 *
 * One rule: `CC_DATA_DIR` when it is set, else `~/.centralu` (`~/.centralu-dev` when `CC_DEV=1`).
 *
 * Before this the host built the folder from the home folder alone and overwrote `CC_DATA_DIR` with it, so
 * `CC_DATA_DIR=/tmp/x pnpm host` opened the real `~/.centralu/store.db`.
 */
export function chooseDataDir(
  env: { CC_DATA_DIR?: string; CC_DEV?: string } = process.env,
  home: string = homedir(),
): string {
  if (env.CC_DATA_DIR) return env.CC_DATA_DIR
  // Packaged when run from the bundled output, dev when run from source (the supervisor tells this)
  return join(home, env.CC_DEV === '1' ? DATA_DIR_DEV : DATA_DIR)
}

/** The files directly in the data folder that hold conversations, tokens or their traces: the store and the host's logs */
const PRIVATE_FILES = ['store.db', 'store.db-wal', 'store.db-shm', 'host.log', 'host.log.1', 'host-errors.log']

/**
 * Makes the data folder readable by its owner only (#838): the folder 0700, the store and the logs in it 0600.
 *
 * It was 0755 with `store.db` and `host.log` 0644, so on a machine with other accounts any of them could read every
 * conversation, the remembered consents and what the log says. The folder's own mode is what protects the rest: a
 * file a build writes later with the default mode (an older one serving during a swap, SQLite's WAL, an app's data)
 * is still behind a folder only its owner can enter. The files named are tightened too, for a copy of the folder
 * made elsewhere.
 *
 * Not `umask(0o077)`: the host's umask is every agent's and every terminal's, and the files they write in the
 * person's projects must keep the person's own modes. Only what is the owner's and not a link is changed, and only
 * on POSIX: Windows keeps the profile folder's ACL, which is already per user.
 * @returns what was changed, for one log line
 */
export function keepDataFolderPrivate(dir: string, platform: Platform = HOST_PLATFORM): string[] {
  if (!modesGuardFiles(platform)) return []
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const changed: string[] = []
  const uid = process.getuid?.()
  const tighten = (path: string, mode: number) => {
    try {
      const st = lstatSync(path)
      if (st.isSymbolicLink() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) === 0) return
      chmodSync(path, mode)
      changed.push(`${path} ${(st.mode & 0o777).toString(8)} -> ${mode.toString(8)}`)
    } catch {
      // Not there, or not ours to change: the host still starts
    }
  }
  tighten(dir, 0o700)
  for (const name of PRIVATE_FILES) tighten(join(dir, name), 0o600)
  return changed
}

/**
 * The data folder to make private for a store at `dbPath` (#838), as its real path, or null when the store is not in
 * the data folder (a `--db` elsewhere: a test's temp folder, a folder of the person's). Compared as real paths, so a
 * trailing slash in `CC_DATA_DIR`, or a data folder reached through a link, still counts as the data folder, and the
 * modes are set on the folder itself rather than skipped on the link.
 */
export function privateDataFolderFor(dbPath: string, root: string = dataRoot()): string | null {
  if (dbPath === ':memory:') return null
  const folder = canonicalPath(dirname(dbPath))
  return folder === canonicalPath(root) ? folder : null
}
