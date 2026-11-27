import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGY_1_4_3_RELEASE, AGY_RELEASE, fetchLatestAgyRelease, parseAgyReleaseFromRegistry } from './release.js'
import { findInstalledAgyVersions } from './agent-files.js'
import { AgySetup } from './setup.js'
import { fakeInstallVersion, makeFolder, tempData } from './agent-files.test-helpers.js'

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
                archive: 'https://example.com/agy-mac-arm64.zip',
                sha256: 'hash-mac-arm64',
                cmd: './agy_acp_server.par',
              },
              'darwin-x86_64': {
                archive: 'https://example.com/agy-mac-x64.zip',
                sha256: 'hash-mac-x64',
                cmd: 'agy_acp_server.par',
              },
              'linux-x86_64': {
                archive: 'https://example.com/agy-linux-x64.zip',
                sha256: 'hash-linux-x64',
                cmd: './agy_acp_server.par',
                args: ['--uid='],
              },
              'linux-aarch64': {
                archive: 'https://example.com/agy-linux-arm64.zip',
                sha256: 'hash-linux-arm64',
                cmd: './agy_acp_server.par',
                args: ['--uid='],
              },
              'windows-x86_64': {
                archive: 'https://example.com/agy-win-x64.zip',
                sha256: 'hash-win-x64',
                cmd: 'agy_acp_server.exe',
              },
              'windows-aarch64': {
                archive: 'https://example.com/agy-win-arm64.zip',
                sha256: 'hash-win-arm64',
                cmd: 'agy_acp_server.exe',
              },
            },
          },
        },
      ],
    }

    it('parses a valid registry JSON into an AgyRelease', () => {
      const release = parseAgyReleaseFromRegistry(sampleRegistry)
      expect(release).not.toBeNull()
      expect(release?.version).toBe('1.5.2')
      expect(release?.archives['darwin-aarch64']).toEqual({
        url: 'https://example.com/agy-mac-arm64.zip',
        sha256: 'hash-mac-arm64',
        command: 'agy_acp_server.par',
        args: [],
        files: ['agy_acp_server.par', 'localharness_external'],
      })
      expect(release?.archives['linux-x86_64']).toEqual({
        url: 'https://example.com/agy-linux-x64.zip',
        sha256: 'hash-linux-x64',
        command: 'agy_acp_server.par',
        args: ['--uid='],
        files: ['agy_acp_server.par', 'localharness_external'],
      })
      expect(release?.archives['windows-x86_64']).toEqual({
        url: 'https://example.com/agy-win-x64.zip',
        sha256: 'hash-win-x64',
        command: 'agy_acp_server.exe',
        args: [],
        files: ['agy_acp_server.exe', 'localharness_external.exe'],
      })
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
                'darwin-aarch64': { archive: 'https://example.com/a.zip', sha256: 's1' },
                'darwin-x86_64': { archive: 'https://example.com/b.zip', sha256: 's2' },
                'linux-x86_64': { archive: 'https://example.com/c.zip', sha256: 's3' },
                'linux-aarch64': { archive: 'https://example.com/d.zip', sha256: 's4' },
                'windows-x86_64': { archive: 'https://example.com/e.zip', sha256: 's5' },
                'windows-aarch64': { archive: 'https://example.com/f.zip', sha256: 's6' },
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
      const setup = new AgySetup({
        home: home143,
        archive: AGY_1_4_3_RELEASE.archives['darwin-aarch64'],
        version: '1.4.3',
        platformKey: 'darwin-aarch64',
        autoUpdate: false,
      })
      const updated = await setup.checkUpdate()
      expect(updated).toBe(false)
      expect(setup.version).toBe('1.4.3')
    })

    it('upgrades to 1.5.2 when currently on 1.4.3', async () => {
      const t = tempData()
      data.push(t)
      const home143 = fakeInstallVersion(t.home, '1.4.3', AGY_1_4_3_RELEASE.archives['darwin-aarch64'])

      let updatedCallbackCalled = false
      const setup = new AgySetup({
        home: home143,
        archive: AGY_1_4_3_RELEASE.archives['darwin-aarch64'],
        version: '1.4.3',
        platformKey: 'darwin-aarch64',
        autoUpdate: true,
        fetchRelease: async () => AGY_RELEASE,
        runInstall: async () => {
          fakeInstallVersion(t.home, '1.5.2', AGY_RELEASE.archives['darwin-aarch64'])
        },
        onVersionUpdated: (info) => {
          updatedCallbackCalled = true
          expect(info.version).toBe('1.5.2')
        },
      })

      expect(setup.version).toBe('1.4.3')
      const updated = await setup.checkUpdate()
      expect(updated).toBe(true)
      expect(setup.version).toBe('1.5.2')
      expect(setup.home.versionDir).toBe(fakeInstallVersion(t.home, '1.5.2', AGY_RELEASE.archives['darwin-aarch64']).versionDir)
      expect(setup.archive).toEqual(AGY_RELEASE.archives['darwin-aarch64'])
      expect(updatedCallbackCalled).toBe(true)
    })

    it('does not upgrade if current version is already newest', async () => {
      const t = tempData()
      data.push(t)
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
})
