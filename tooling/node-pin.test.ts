/**
 * The Node a remote runs (docs/plans/remote-hub.md §10.2, §10.3; owner decision 1 of §10.9):
 * `packaging/remote-runtime.json` is the one place its version and archive hashes live, the release
 * checks it against Node's signed SHASUMS256.txt (`scripts/node-pin.mjs`), the host bundle carries
 * it, and CI runs the host's tests on that version. Each of those reads the same file; these tests
 * hold them to it.
 *
 * The fixtures are Node 24.21.0's real SHASUMS256.txt, its detached signature and the key of the
 * releaser who signed it (nodejs/release-keys at the commit the pin names).
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  checkPinShape,
  dearmor,
  NODE_ARCHIVES,
  pinFrom,
  pinProblems,
  readPin,
  validSigner,
  verifyDetached,
  // @ts-expect-error — plain .mjs so the release's first job runs it before anything is installed
} from '../scripts/node-pin.mjs'

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const fixture = (name: string) => readFileSync(root(`tooling/fixtures/node-pin/${name}`))
const SIGNER = '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356'

type Pin = { node: { version: string; signedBy: string; releaseKeys: string; archives: Record<string, { file: string; sha256: string }> } }
const pin = readPin() as Pin

describe('the pinned Node', () => {
  it('is an exact 24.x release with a hash for every platform the installer serves', () => {
    expect(pin.node.version).toMatch(/^24\.\d+\.\d+$/)
    expect(Object.keys(pin.node.archives).sort()).toEqual(['linux-arm64', 'linux-x64', 'win32-x64'])
    expect(pin.node.archives['win32-x64']!.file).toBe(`node-v${pin.node.version}-win-x64.zip`)
    expect(pin.node.archives['linux-x64']!.file).toBe(`node-v${pin.node.version}-linux-x64.tar.gz`)
  })

  it('serves exactly the platforms that have a package, except macOS', () => {
    const shim = JSON.parse(readFileSync(root('packaging/npm/centralu/package.json'), 'utf8')) as { optionalDependencies: Record<string, string> }
    const published = Object.keys(shim.optionalDependencies).map((p) => p.replace('@centralu/', ''))
    expect(Object.keys(NODE_ARCHIVES).sort()).toEqual(published.filter((id) => !id.startsWith('darwin-')).sort())
  })

  it('refuses another major, a range, or a missing archive', () => {
    const at = (node: Partial<Pin['node']>) => () => checkPinShape({ node: { ...pin.node, ...node } })
    expect(at({ version: '22.20.0' })).toThrow(/not 24\.x/)
    expect(at({ version: '^24.21.0' })).toThrow(/not an exact version/)
    expect(at({ archives: { 'linux-x64': pin.node.archives['linux-x64']! } })).toThrow(/expected linux-arm64, linux-x64, win32-x64/)
    expect(at({ signedBy: 'abc' })).toThrow(/not a key fingerprint/)
  })

  it('is what the signed SHASUMS256.txt of its version says, archive by archive', () => {
    const shasums = fixture('SHASUMS256.txt').toString('utf8')
    expect(pinProblems(pin, shasums)).toEqual([])
    expect(pinFrom(pin.node.version, shasums, { signedBy: pin.node.signedBy, releaseKeys: pin.node.releaseKeys })).toEqual(pin)
  })

  it('names an archive whose pinned hash is not the signed one', () => {
    const shasums = fixture('SHASUMS256.txt').toString('utf8')
    const swapped = { node: { ...pin.node, archives: { ...pin.node.archives, 'win32-x64': { ...pin.node.archives['win32-x64']!, sha256: '0'.repeat(64) } } } }
    expect(pinProblems(swapped, shasums)).toEqual([expect.stringMatching(/^win32-x64: node-v24\.\d+\.\d+-win-x64\.zip is pinned as 0{64}, the signed list says [0-9a-f]{64}$/)])
    const missing = shasums.replace(/^.*linux-arm64\.tar\.gz\n/m, '')
    expect(pinProblems(pin, missing)).toEqual([expect.stringMatching(/^linux-arm64: .* is not in the signed SHASUMS256\.txt$/)])
  })
})

describe('the signature check', () => {
  it('reads the primary key out of an armored key and the signer out of gpgv’s status', () => {
    // A v4 public key packet: tag 6 in an old-format header (0x98 or 0x99)
    expect([0x98, 0x99]).toContain(dearmor(fixture(`${SIGNER}.asc`).toString('utf8'))[0])
    const status = `[GNUPG:] GOODSIG 20B1A390B168D356 x\n[GNUPG:] VALIDSIG AAAA${'0'.repeat(36)} 2026-09-08 1788904155 0 4 0 22 8 00 ${SIGNER.toLowerCase()}\n`
    expect(validSigner(status)).toBe(SIGNER)
    expect(validSigner('[GNUPG:] BADSIG 20B1A390B168D356 x')).toBeNull()
  })

  const gpgv = spawnSync('gpgv', ['--version']).status === 0
  it.skipIf(!gpgv)('accepts Node’s own signature with the pinned key, and refuses one changed byte', () => {
    const args = { sig: fixture('SHASUMS256.txt.sig'), keys: [fixture(`${SIGNER}.asc`).toString('utf8')] }
    const data = fixture('SHASUMS256.txt')
    expect(verifyDetached({ ...args, data })).toBe(SIGNER)
    const tampered = Buffer.from(data)
    tampered[0] = tampered[0] === 0x30 ? 0x31 : 0x30
    expect(() => verifyDetached({ ...args, data: tampered })).toThrow(/does not verify/)
  })
})

describe('who reads the pin', () => {
  const build = readFileSync(root('.github/workflows/build.yml'), 'utf8')
  const release = readFileSync(root('.github/workflows/release.yml'), 'utf8')

  /** One job's lines, comments dropped (the same line scan release-workflow.test.ts uses) */
  function job(text: string, name: string): string {
    const lines = text.split('\n')
    const start = lines.indexOf(`  ${name}:`)
    expect(start, `no job "${name}"`).toBeGreaterThan(-1)
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((l) => /^ {2}\S/.test(l))
    return (end === -1 ? rest : rest.slice(0, end)).filter((l) => !l.trim().startsWith('#')).join('\n')
  }

  it('CI runs the host’s tests on the pinned Node, on Linux and Windows, beside the jobs on 22', () => {
    const j = job(build, 'host-tests-remote-node')
    expect(j).toContain(`require("./packaging/remote-runtime.json").node.version`)
    expect(j).toContain('node-version: ${{ steps.pin.outputs.node }}')
    expect(j).toMatch(/runner: \[ubuntu-24\.04, windows-2022\]/)
    expect(j).toMatch(/vitest run packages\/agent-host packages\/protocol tooling\/launcher-/)
    // Added, not swapped: the app's own host still runs on the person's Node, 22 or later
    expect(job(build, 'verify')).toContain('node-version: 22')
    expect(job(build, 'windows-tests')).toContain('node-version: 22')
  })

  it('the release checks the pin against Node’s signature before anything is built', () => {
    expect(job(release, 'guard')).toContain('node scripts/node-pin.mjs')
  })

  it('the host bundle carries the pin, and the release compares the copy with it', () => {
    expect(readFileSync(root('packages/agent-host/scripts/bundle.mjs'), 'utf8')).toContain(
      "cpSync(join(ROOT, 'packaging/remote-runtime.json'), join(OUT, 'remote-runtime.json'))",
    )
    const npm = readFileSync(root('scripts/release-npm.mts'), 'utf8')
    // One call per platform package: Linux (shared by both arches), macOS, Windows
    expect(npm.match(/checkRemoteRuntime\(join\(/g)).toHaveLength(3)
  })
})
