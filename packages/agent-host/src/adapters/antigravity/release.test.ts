import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGY_1_4_3_RELEASE, AGY_RELEASE, fetchLatestAgyRelease, parseAgyReleaseFromRegistry, type AgyArchive } from './release.js'
import { agyHomeWithVersion, findInstalledAgyVersions } from './agent-files.js'
import { AgySetup } from './setup.js'
import { antigravityProfile } from './index.js'
import { fakeInstallVersion, makeFolder, tempData } from './agent-files.test-helpers.js'

const CDN = 'https://dl.google.com/agy-extensions/releases'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)
const HASH_E = 'e'.repeat(64)
const HASH_F = 'f'.repeat(64)

describe('Antigravity ACP release and auto-update', () => {
  const data: { done(): void }[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const d of data.splice(0)) d.done()
  })

  describe('parseAgyReleaseFromRegistry', () => {
    const sampleRegistry = {
      agents: [
        {
          id: 'other-agent',
          version: '0.1.0',
        },
        {
          id: 'antigravity-acp',
          version: '1.5.2',
          distribution: {
            binary: {
              'darwin-aarch64': {
                archive: `${CDN}/macos/agy-acp-server-1.5.2-darwin-arm64.zip`,
                sha256: HASH_A.toUpperCase(),
                cmd: './agy_acp_server.par',
              },
              'darwin-x86_64': {
                archive: `${CDN}/macos/agy-acp-server-1.5.2-darwin-x86_64.zip`,
                sha256: HASH_B,
                cmd: 'agy_acp_server.par',
              },
              'linux-x86_64': {
                archive: `${CDN}/linux/agy-acp-server-1.5.2-linux-x86_64.zip`,
                sha256: HASH_C,
                cmd: './agy_acp_server.par',
                args: ['--uid='],
              },
              'linux-aarch64': {
                archive: `${CDN}/linux/agy-acp-server-1.5.2-linux-arm64.zip`,
                sha256: HASH_D,
                cmd: './agy_acp_server.par',
                args: ['--uid='],
              },
              'windows-x86_64': {
                archive: `${CDN}/windows/agy-acp-server-1.5.2-windows-x86_64.zip`,
                sha256: HASH_E,
                cmd: 'agy_acp_server.exe',
              },
              'windows-aarch64': {
                archive: `${CDN}/windows/agy-acp-server-1.5.2-windows-arm64.zip`,
                sha256: HASH_F,
                cmd: 'agy_acp_server.exe',
              },
            },
          },
        },
      ],
    }

    it('parses a valid registry JSON into an AgyRegistryRelease and normalizes uppercase sha256', () => {
      const release = parseAgyReleaseFromRegistry(sampleRegistry)
      expect(release).not.toBeNull()
      expect(release?.version).toBe('1.5.2')
      expect(release?.archives['darwin-aarch64']).toEqual({
        url: `${CDN}/macos/agy-acp-server-1.5.2-darwin-arm64.zip`,
        sha256: HASH_A,
        command: 'agy_acp_server.par',
        args: [],
        files: ['agy_acp_server.par', 'localharness_external'],
      })
      expect(release?.archives['linux-x86_64']).toEqual({
        url: `${CDN}/linux/agy-acp-server-1.5.2-linux-x86_64.zip`,
        sha256: HASH_C,
        command: 'agy_acp_server.par',
        args: ['--uid='],
        files: ['agy_acp_server.par', 'localharness_external'],
      })
      expect(release?.archives['windows-x86_64']).toEqual({
        url: `${CDN}/windows/agy-acp-server-1.5.2-windows-x86_64.zip`,
        sha256: HASH_E,
        command: 'agy_acp_server.exe',
        args: [],
        files: ['agy_acp_server.exe', 'localharness_external.exe'],
      })
    })

    it('accepts a partial platform release when at least one valid platform is present', () => {
      const partial = {
        agents: [
          {
            id: 'antigravity-acp',
            version: '1.6.0',
            distribution: {
              binary: {
                'darwin-aarch64': {
                  archive: `${CDN}/macos/agy-acp-server-1.6.0-darwin-arm64.zip`,
                  sha256: HASH_A,
                },
              },
            },
          },
        ],
      }
      const release = parseAgyReleaseFromRegistry(partial)
      expect(release?.version).toBe('1.6.0')
      expect(release?.archives['darwin-aarch64']?.sha256).toBe(HASH_A)
      expect(release?.archives['windows-x86_64']).toBeUndefined()
    })

    it('rejects malicious or invalid version, archive URL, sha256, or cmd values', () => {
      const base = (over: { version?: string; archive?: string; sha256?: string; cmd?: string }) => ({
        agents: [
          {
            id: 'antigravity-acp',
            version: over.version ?? '1.6.0',
            distribution: {
              binary: {
                'darwin-aarch64': {
                  archive: over.archive ?? `${CDN}/macos/agy-acp-server-1.6.0-darwin-arm64.zip`,
                  sha256: over.sha256 ?? HASH_A,
                  ...(over.cmd !== undefined ? { cmd: over.cmd } : {}),
                },
              },
            },
          },
        ],
      })
      expect(parseAgyReleaseFromRegistry(base({ version: '9.9.9-../../evil' }))).toBeNull()
      expect(parseAgyReleaseFromRegistry(base({ version: '../1.6.0' }))).toBeNull()
      expect(parseAgyReleaseFromRegistry(base({ archive: 'https://evil.example/agy.zip' }))).toBeNull()
      expect(parseAgyReleaseFromRegistry(base({ archive: 'http://dl.google.com/agy-extensions/releases/a.zip' }))).toBeNull()
      expect(parseAgyReleaseFromRegistry(base({ archive: `${CDN}/../../secret.zip` }))).toBeNull()
      expect(parseAgyReleaseFromRegistry(base({ sha256: 'not-a-sha256' }))).toBeNull()
      expect(parseAgyReleaseFromRegistry(base({ cmd: '../evil' }))).toBeNull()
      expect(parseAgyReleaseFromRegistry(base({ cmd: 'sub/bin' }))).toBeNull()
    })

    it('returns null on invalid or missing structure', () => {
      expect(parseAgyReleaseFromRegistry(null)).toBeNull()
      expect(parseAgyReleaseFromRegistry({})).toBeNull()
      expect(parseAgyReleaseFromRegistry({ agents: [] })).toBeNull()
      expect(
        parseAgyReleaseFromRegistry({
          agents: [{ id: 'antigravity-acp', version: '1.5.2', distribution: {} }],
        }),
      ).toBeNull()
      expect(
        parseAgyReleaseFromRegistry({
          agents: [{ id: 'antigravity-acp', version: '1.5.2', distribution: { binary: { 'darwin-aarch64': {} } } }],
        }),
      ).toBeNull()
    })
  })

  describe('fetchLatestAgyRelease', () => {
    it('fetches and parses registry JSON successfully', async () => {
      const mockJson = {
        agents: [
          {
            id: 'antigravity-acp',
            version: '1.5.2',
            distribution: {
              binary: {
                'darwin-aarch64': { archive: `${CDN}/macos/a.zip`, sha256: HASH_A },
              },
            },
          },
        ],
      }
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockJson,
      } as Response)

      const release = await fetchLatestAgyRelease('https://mock-registry.test')
      expect(release).not.toBeNull()
      expect(release?.version).toBe('1.5.2')
    })

    it('returns null on HTTP error or network failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response)
      expect(await fetchLatestAgyRelease('https://mock-registry.test')).toBeNull()

      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'))
      expect(await fetchLatestAgyRelease('https://mock-registry.test')).toBeNull()
    })
  })

  describe('findInstalledAgyVersions', () => {
    it('returns empty array when folder does not exist', () => {
      expect(findInstalledAgyVersions('/path/that/does/not/exist')).toEqual([])
    })

    it('finds and sorts installed versions newest first', () => {
      const t = tempData()
      data.push(t)
      makeFolder(t.home.root, 'gemini-home')
      makeFolder(t.home.root, 'tmp')
      makeFolder(t.home.root, 'usage')

      // Folder without marker
      makeFolder(t.home.root, '1.4.0')

      // Valid installed versions
      fakeInstallVersion(t.home, '1.4.3', AGY_1_4_3_RELEASE.archives['darwin-aarch64'])
      fakeInstallVersion(t.home, '1.5.2', AGY_RELEASE.archives['darwin-aarch64'])

      const versions = findInstalledAgyVersions(t.home.root)
      expect(versions).toEqual(['1.5.2', '1.4.3'])
    })
  })

  describe('AgySetup auto-update', () => {
    it('does nothing when autoUpdate is false', async () => {
      const t = tempData()
      data.push(t)
      const home143 = fakeInstallVersion(t.home, '1.4.3', AGY_1_4_3_RELEASE.archives['darwin-aarch64'])
      const fetchRelease = vi.fn(async () => AGY_RELEASE)
      const setup = new AgySetup({
        home: home143,
        archive: AGY_1_4_3_RELEASE.archives['darwin-aarch64'],
        version: '1.4.3',
        platformKey: 'darwin-aarch64',
        autoUpdate: false,
        fetchRelease,
      })
      const updated = await setup.checkUpdate()
      expect(updated).toBe(false)
      expect(fetchRelease).not.toHaveBeenCalled()
      expect(setup.version).toBe('1.4.3')
    })

    it('never installs silently when Antigravity is not yet installed', async () => {
      const t = tempData()
      data.push(t)
      const fetchRelease = vi.fn(async () => AGY_RELEASE)
      const runInstall = vi.fn(async () => {})
      const setup = new AgySetup({
        home: t.home,
        archive: AGY_RELEASE.archives['darwin-aarch64'],
        version: '1.5.2',
        platformKey: 'darwin-aarch64',
        autoUpdate: true,
        fetchRelease,
        runInstall,
      })
      const updated = await setup.checkUpdate()
      expect(updated).toBe(false)
      expect(fetchRelease).not.toHaveBeenCalled()
      expect(runInstall).not.toHaveBeenCalled()
      expect(setup.installed()).toBe(false)
    })

    it('upgrades to 1.5.2 when currently on 1.4.3 and deduplicates concurrent checkUpdate calls', async () => {
      const t = tempData()
      data.push(t)
      const home143 = fakeInstallVersion(t.home, '1.4.3', AGY_1_4_3_RELEASE.archives['darwin-aarch64'])

      let fetchCalls = 0
      let installCalls = 0
      let updatedCallbackCalled = false
      const setup = new AgySetup({
        home: home143,
        archive: AGY_1_4_3_RELEASE.archives['darwin-aarch64'],
        version: '1.4.3',
        platformKey: 'darwin-aarch64',
        autoUpdate: true,
        fetchRelease: async () => {
          fetchCalls++
          return AGY_RELEASE
        },
        runInstall: async () => {
          installCalls++
          fakeInstallVersion(t.home, '1.5.2', AGY_RELEASE.archives['darwin-aarch64'])
        },
        onVersionUpdated: (info) => {
          updatedCallbackCalled = true
          expect(info.version).toBe('1.5.2')
        },
      })

      expect(setup.version).toBe('1.4.3')
      // Constructor does not hit network on its own
      await setup.whenTidy()
      expect(fetchCalls).toBe(0)

      const [r1, r2] = await Promise.all([setup.checkUpdate(), setup.checkUpdate()])
      expect(r1).toBe(true)
      expect(r2).toBe(true)
      expect(fetchCalls).toBe(1)
      expect(installCalls).toBe(1)
      expect(setup.version).toBe('1.5.2')
      expect(setup.home.versionDir).toBe(agyHomeWithVersion(t.home, '1.5.2').versionDir)
      expect(setup.archive).toEqual(AGY_RELEASE.archives['darwin-aarch64'])
      expect(updatedCallbackCalled).toBe(true)
    })

    it('keeps existing version when checkUpdate fails during install', async () => {
      const t = tempData()
      data.push(t)
      const home143 = fakeInstallVersion(t.home, '1.4.3', AGY_1_4_3_RELEASE.archives['darwin-aarch64'])
      const setup = new AgySetup({
        home: home143,
        archive: AGY_1_4_3_RELEASE.archives['darwin-aarch64'],
        version: '1.4.3',
        platformKey: 'darwin-aarch64',
        autoUpdate: true,
        fetchRelease: async () => AGY_RELEASE,
        runInstall: async () => {
          throw new Error('download failed')
        },
      })
      const updated = await setup.checkUpdate()
      expect(updated).toBe(false)
      expect(setup.version).toBe('1.4.3')
      expect(setup.installed()).toBe(true)
    })

    it('does not upgrade if current version is already newest', async () => {
      const t = tempData()
      data.push(t)
      fakeInstallVersion(t.home, '1.5.2', AGY_RELEASE.archives['darwin-aarch64'])
      const setup = new AgySetup({
        home: t.home,
        archive: AGY_RELEASE.archives['darwin-aarch64'],
        version: '1.5.2',
        platformKey: 'darwin-aarch64',
        autoUpdate: true,
        fetchRelease: async () => AGY_RELEASE,
      })
      const updated = await setup.checkUpdate()
      expect(updated).toBe(false)
      expect(setup.version).toBe('1.5.2')
    })
  })

  describe('antigravityProfile startup recovery', () => {
    it('restores an auto-updated version (> 1.5.2) across restart from install.json metadata', async () => {
      const t = tempData()
      data.push(t)
      const archive160: AgyArchive = {
        url: `${CDN}/macos/agy-acp-server-1.6.0-darwin-arm64.zip`,
        sha256: HASH_A,
        command: 'agy_acp_server.par',
        args: [],
        files: ['agy_acp_server.par', 'localharness_external'],
      }
      fakeInstallVersion(t.home, '1.6.0', archive160)

      const profile = antigravityProfile({ dataDir: t.dir, platform: 'darwin', arch: 'arm64' })
      expect(profile.agySetup.version).toBe('1.6.0')
      expect(profile.agySetup.installed()).toBe(true)
      expect(profile.archive).toEqual(archive160)
      expect(await profile.installedVersion?.()).toBe('1.6.0')
    })

    it('restores a legacy 1.4.3 marker and skips corrupted newer version directories', () => {
      const t = tempData()
      data.push(t)
      fakeInstallVersion(t.home, '1.4.3', AGY_1_4_3_RELEASE.archives['darwin-aarch64'], true)
      // Corrupted 1.6.0 folder without binaries
      makeFolder(t.home.root, '1.6.0')

      const profile = antigravityProfile({ dataDir: t.dir, platform: 'darwin', arch: 'arm64' })
      expect(profile.agySetup.version).toBe('1.4.3')
      expect(profile.agySetup.installed()).toBe(true)
    })
  })
})
