/**
 * The one version of Google's Antigravity ACP agent this build installs (docs/plans/antigravity-adapter.md §3): the ACP
 * registry's entry `antigravity-acp`, copied here by hand, so a build downloads the archive its tests and review saw and checks
 * the sha256 the registry published for it. A newer agent is never fetched by itself: a newer Centralu pins it.
 */

import { z } from 'zod'

export type AgyPlatformKey = 'darwin-aarch64' | 'darwin-x86_64' | 'linux-x86_64' | 'linux-aarch64' | 'windows-x86_64' | 'windows-aarch64'

export type AgyArchive = {
  url: string
  sha256: string
  /** The server's file name in the archive (the registry's `cmd` without `./`) */
  command: string
  args: readonly string[]
  /** Every file the archive must hold, the server first; `localharness_external` runs its tools and must sit beside it. Any other file refuses the install */
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

export const AGY_1_4_3_RELEASE: AgyRelease = {
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
 * Registry entry `antigravity-acp` 1.5.2, read 2026-11-27 from ACP registry:
 * https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 */
export const AGY_RELEASE: AgyRelease = {
  version: '1.5.2',
  oauthClient: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  archives: {
    'darwin-aarch64': posix(`${BASE}/macos/agy-acp-server-1.5.2-darwin-arm64.zip`, '123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845'),
    'darwin-x86_64': posix(`${BASE}/macos/agy-acp-server-1.5.2-darwin-x86_64.zip`, '92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06'),
    'linux-x86_64': posix(`${BASE}/linux/agy-acp-server-1.5.2-linux-x86_64.zip`, '99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852', ['--uid=']),
    'linux-aarch64': posix(`${BASE}/linux/agy-acp-server-1.5.2-linux-arm64.zip`, 'e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb', ['--uid=']),
    'windows-x86_64': windows(`${BASE}/windows/agy-acp-server-1.5.2-windows-x86_64.zip`, '5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6'),
    'windows-aarch64': windows(`${BASE}/windows/agy-acp-server-1.5.2-windows-arm64.zip`, '8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab'),
  },
}

export const KNOWN_AGY_RELEASES: Record<string, AgyRelease> = {
  '1.4.3': AGY_1_4_3_RELEASE,
  '1.5.2': AGY_RELEASE,
}

export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

const acpBinaryEntrySchema = z.object({
  archive: z.string(),
  sha256: z.string(),
  cmd: z.string().optional(),
  args: z.array(z.string()).optional(),
})

const acpRegistrySchema = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      version: z.string().optional(),
      distribution: z
        .object({
          binary: z.record(z.string(), acpBinaryEntrySchema).optional(),
        })
        .optional(),
    }),
  ),
})

/** Parses an AgyRelease from the ACP registry's registry.json */
export function parseAgyReleaseFromRegistry(json: unknown): AgyRelease | null {
  const parsed = acpRegistrySchema.safeParse(json)
  if (!parsed.success) return null
  const entry = parsed.data.agents.find((a) => a.id === 'antigravity-acp')
  if (!entry?.version || !entry.distribution?.binary) return null
  const binary = entry.distribution.binary
  const darwinAarch64 = binary['darwin-aarch64']
  const darwinX86_64 = binary['darwin-x86_64']
  const linuxX86_64 = binary['linux-x86_64']
  const linuxAarch64 = binary['linux-aarch64']
  const windowsX86_64 = binary['windows-x86_64']
  const windowsAarch64 = binary['windows-aarch64']
  if (!darwinAarch64 || !darwinX86_64 || !linuxX86_64 || !linuxAarch64 || !windowsX86_64 || !windowsAarch64) return null

  const toArchive = (b: z.infer<typeof acpBinaryEntrySchema>, isWin: boolean): AgyArchive => {
    const cmd = b.cmd ? b.cmd.replace(/^\.\//, '') : isWin ? 'agy_acp_server.exe' : 'agy_acp_server.par'
    const harness = isWin ? 'localharness_external.exe' : 'localharness_external'
    return {
      url: b.archive,
      sha256: b.sha256,
      command: cmd,
      args: b.args ?? [],
      files: [cmd, harness],
    }
  }

  return {
    version: entry.version,
    oauthClient: AGY_RELEASE.oauthClient,
    archives: {
      'darwin-aarch64': toArchive(darwinAarch64, false),
      'darwin-x86_64': toArchive(darwinX86_64, false),
      'linux-x86_64': toArchive(linuxX86_64, false),
      'linux-aarch64': toArchive(linuxAarch64, false),
      'windows-x86_64': toArchive(windowsX86_64, true),
      'windows-aarch64': toArchive(windowsAarch64, true),
    },
  }
}

/** Fetches the latest published Antigravity ACP release definition from the official ACP registry */
export async function fetchLatestAgyRelease(registryUrl = ACP_REGISTRY_URL, timeoutMs = 10_000): Promise<AgyRelease | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(registryUrl, { signal: ctrl.signal })
    if (!res.ok) return null
    const json: unknown = await res.json()
    return parseAgyReleaseFromRegistry(json)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Free space an install needs where it unpacks: the archive and what it unpacks to side by side until the archive is
 * removed (measured: 110 MB zipped and 405 MB unpacked on macOS arm64, 131 MB and 235 MB on Windows x64), with room to spare
 */
export const AGY_INSTALL_SPACE_BYTES = 700 * 1024 * 1024
