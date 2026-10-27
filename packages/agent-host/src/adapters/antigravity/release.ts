/**
 * The one version of Google's Antigravity ACP agent this build of Centralu installs (docs/plans/antigravity-adapter.md §3):
 * the ACP registry's entry `antigravity-acp`, copied here by hand when a release moves to a newer one, so a build always
 * downloads the archive its tests and its review saw, and checks it against the sha256 the registry published for it. A
 * newer agent is never fetched by itself: a newer Centralu pins it.
 *
 * Per platform: the archive's address, its sha256, and how the server inside it starts (the registry's `cmd` and `args`).
 * Every archive holds the server and `localharness_external`, which runs its tools and must stay in the same folder.
 */

export type AgyPlatformKey = 'darwin-aarch64' | 'darwin-x86_64' | 'linux-x86_64' | 'linux-aarch64' | 'windows-x86_64' | 'windows-aarch64'

export type AgyArchive = {
  url: string
  sha256: string
  /** The server's file name in the archive (the registry's `cmd` without `./`) */
  command: string
  args: readonly string[]
  /** Every file the archive must hold, the server first; anything else in it refuses the install */
  files: readonly string[]
}

export type AgyRelease = {
  version: string
  /**
   * The agent's own OAuth client, as it stands in the login address this version hands `BROWSER` (public; measured on
   * each bump with a token the agent cannot use, plan §4.3). The only address taken for its sign-in, in a sign-in and in a
   * session (`agentSignInUrl`): a stale one opens no browser for a sign-in and leaves a session start waiting on the
   * agent's own login, so it moves with the version and the sha256s
   */
  oauthClient: string
  archives: Readonly<Record<AgyPlatformKey, AgyArchive>>
}

const BASE = 'https://dl.google.com/agy-extensions/releases'

const posix = (url: string, sha256: string, args: readonly string[] = []): AgyArchive => ({
  url,
  sha256,
  command: 'agy_acp_server.par',
  args,
  files: ['agy_acp_server.par', 'localharness_external'],
})

const windows = (url: string, sha256: string): AgyArchive => ({
  url,
  sha256,
  command: 'agy_acp_server.exe',
  args: [],
  files: ['agy_acp_server.exe', 'localharness_external.exe'],
})

/**
 * Registry entry `antigravity-acp` 1.4.3, read 2026-10-27; the Windows x64 archive was downloaded and its sha256 matched.
 * Its OAuth client read from the login address it handed `BROWSER` on Windows (and seen on the same page on Linux)
 */
export const AGY_RELEASE: AgyRelease = {
  version: '1.4.3',
  oauthClient: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  archives: {
    'darwin-aarch64': posix(`${BASE}/macos/agy-acp-server-1.4.3-darwin-arm64.zip`, 'c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b'),
    'darwin-x86_64': posix(`${BASE}/macos/agy-acp-server-1.4.3-darwin-x86_64.zip`, '9392dbbdad7f0663dbfb5a0bf641297b0cf80d2ee9cd2d49a616bbbc7378731d'),
    'linux-x86_64': posix(`${BASE}/linux/agy-acp-server-1.4.3-linux-x86_64.zip`, '0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714', ['--uid=']),
    'linux-aarch64': posix(`${BASE}/linux/agy-acp-server-1.4.3-linux-arm64.zip`, '05c153443b0b1175151c760eeddea538950bc9843e317d54786a1f03670182bc', ['--uid=']),
    'windows-x86_64': windows(`${BASE}/windows/agy-acp-server-1.4.3-windows-x86_64.zip`, '54c2e16378d9a4952e1da70e355f3c33c4f284308d6de48ab3e6e34a127bd325'),
    'windows-aarch64': windows(`${BASE}/windows/agy-acp-server-1.4.3-windows-arm64.zip`, 'fcd46431ad33d3b510ce0b98fe7b43d095bd8b3f1c363ee2d57faa7ee981c7bb'),
  },
}

/**
 * Free space an install needs where it unpacks: the archive and what it unpacks to side by side until the archive is
 * removed (measured: 110 MB zipped and 405 MB unpacked on macOS arm64, 131 MB and 235 MB on Windows x64), with room to spare
 */
export const AGY_INSTALL_SPACE_BYTES = 700 * 1024 * 1024
