#!/usr/bin/env node
/**
 * The Node a remote runs, pinned (docs/plans/remote-hub.md §10.2, §10.3; owner decision 1 of §10.9).
 *
 * A host the hub installs on another machine runs on a Node the hub downloads there from nodejs.org,
 * not on whatever Node that machine has. `packaging/remote-runtime.json` names it: the version, and
 * the SHA-256 of the archive for each platform the installer serves. That file is the one place the
 * version lives. The release copies it into the host bundle (`remote-runtime.json` beside `main.mjs`,
 * `packages/agent-host/scripts/bundle.mjs`), where the hub's installer reads it and sends the remote
 * the hash for its platform. CI reads the same file to run the host's tests on that Node.
 *
 * **The remote never trusts a hash it fetched beside the archive.** These hashes come from Node's
 * `SHASUMS256.txt`, checked against its detached signature with the release key of the person who
 * signed that release. The key is fetched from the `nodejs/release-keys` repository at a pinned
 * commit, which names its content by hash, so neither the key nor the hashes depend on what
 * nodejs.org serves on the day the remote installs.
 *
 *   node scripts/node-pin.mjs                  check the pin against the signed SHASUMS256.txt (the release runs this)
 *   node scripts/node-pin.mjs --set 24.22.0    move the pin to another release, after the same check
 *
 * Needs `gpgv` (GnuPG's verify-only tool: no agent, no keyring of the person's). It runs with a
 * temporary home folder, so it never reads or writes `~/.gnupg`.
 *
 * Plain JavaScript on Node's own modules, so the release's first job can run it before anything is
 * installed. `tooling/node-pin.test.ts` imports the pure parts.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PIN_FILE = fileURLToPath(new URL('../packaging/remote-runtime.json', import.meta.url))

/**
 * The archive each remote platform downloads, by the platform's id in Centralu's packages
 * (`@centralu/<id>`, `process.platform-process.arch`). `.tar.gz` on Linux rather than the smaller
 * `.tar.xz`: `xz` is not on every server, and `tar` with `gzip` is (§10.7). `.zip` on Windows, which
 * Windows' own `tar.exe` unpacks. macOS is not listed: a Mac remote keeps phase 1's npm install.
 */
export const NODE_ARCHIVES = {
  'linux-arm64': (v) => `node-v${v}-linux-arm64.tar.gz`,
  'linux-x64': (v) => `node-v${v}-linux-x64.tar.gz`,
  'win32-x64': (v) => `node-v${v}-win-x64.zip`,
}

/** The major the owner chose (24 LTS, supported to April 2028). Moving to another is a decision, not a bump */
export const NODE_MAJOR = 24

const HEX40 = /^[0-9A-F]{40}$/
const SHA1 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

/** The pin, or a thrown sentence saying what is wrong with it */
export function readPin(file = PIN_FILE) {
  return checkPinShape(JSON.parse(readFileSync(file, 'utf8')))
}

export function checkPinShape(pin) {
  const n = pin?.node
  const where = 'packaging/remote-runtime.json'
  if (!n || typeof n !== 'object') throw new Error(`${where} has no "node"`)
  if (typeof n.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(n.version)) throw new Error(`${where}: "node.version" is not an exact version: ${JSON.stringify(n.version)}`)
  if (Number(n.version.split('.')[0]) !== NODE_MAJOR) throw new Error(`${where}: Node ${n.version} is not ${NODE_MAJOR}.x, the major the owner chose (remote-hub.md §10.9)`)
  if (!HEX40.test(n.signedBy ?? '')) throw new Error(`${where}: "node.signedBy" is not a key fingerprint (40 uppercase hex digits)`)
  if (!SHA1.test(n.releaseKeys ?? '')) throw new Error(`${where}: "node.releaseKeys" is not a commit of nodejs/release-keys`)
  const ids = Object.keys(n.archives ?? {}).sort()
  const want = Object.keys(NODE_ARCHIVES).sort()
  if (ids.join() !== want.join()) throw new Error(`${where}: archives for ${ids.join(', ') || 'nothing'}; expected ${want.join(', ')}`)
  for (const id of want) {
    const a = n.archives[id]
    if (a.file !== NODE_ARCHIVES[id](n.version)) throw new Error(`${where}: ${id} names ${a.file}, not ${NODE_ARCHIVES[id](n.version)}`)
    if (!SHA256.test(a.sha256 ?? '')) throw new Error(`${where}: ${id} has no SHA-256`)
  }
  return pin
}

/** `SHASUMS256.txt` as file name → hash */
export function parseShasums(text) {
  const out = new Map()
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64}) {1,2}\*?(\S+)$/.exec(line.trim())
    if (m) out.set(m[2], m[1])
  }
  return out
}

/** The pin for a version, from its (already verified) SHASUMS256.txt */
export function pinFrom(version, shasums, { signedBy, releaseKeys }) {
  const sums = parseShasums(shasums)
  const archives = {}
  for (const [id, name] of Object.entries(NODE_ARCHIVES)) {
    const file = name(version)
    const sha256 = sums.get(file)
    if (!sha256) throw new Error(`SHASUMS256.txt of Node ${version} lists no ${file}`)
    archives[id] = { file, sha256 }
  }
  return checkPinShape({ node: { version, signedBy, releaseKeys, archives } })
}

/** Every archive whose pinned hash differs from the signed list, in words; empty when they agree */
export function pinProblems(pin, shasums) {
  const sums = parseShasums(shasums)
  const problems = []
  for (const [id, a] of Object.entries(pin.node.archives)) {
    const signed = sums.get(a.file)
    if (!signed) problems.push(`${id}: ${a.file} is not in the signed SHASUMS256.txt`)
    else if (signed !== a.sha256) problems.push(`${id}: ${a.file} is pinned as ${a.sha256}, the signed list says ${signed}`)
  }
  return problems
}

/**
 * The binary key from an ASCII-armored one, as `gpg --dearmor` writes it. Done here so the check
 * needs `gpgv` alone: `gpg` would start an agent and want a home folder of its own.
 */
export function dearmor(armored) {
  const lines = String(armored).split(/\r?\n/)
  const begin = lines.findIndex((l) => l.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'))
  const end = lines.findIndex((l, i) => i > begin && l.startsWith('-----END PGP PUBLIC KEY BLOCK-----'))
  if (begin === -1 || end === -1) throw new Error('not an armored public key')
  let i = begin + 1
  while (i < end && lines[i].trim() !== '') i++ // the armor headers end at the first empty line
  const body = lines.slice(i + 1, end).filter((l) => !l.startsWith('=')) // `=XXXX` is the CRC
  return Buffer.from(body.join(''), 'base64')
}

/** The primary key fingerprint of the signer, from gpgv's `VALIDSIG` status line; null without one */
export function validSigner(status) {
  const m = /^\[GNUPG:\] VALIDSIG (\S+)(?: \S+){8} (\S+)$/m.exec(String(status))
  return m ? m[2].toUpperCase() : null
}

/**
 * Checks `sig` over `data` with exactly the given keys, and returns the signer's primary fingerprint.
 * Throws when gpgv is missing, the signature does not verify, or no key matches.
 */
export function verifyDetached({ data, sig, keys, gpgv = 'gpgv' }) {
  const dir = mkdtempSync(join(tmpdir(), 'centralu-node-pin-'))
  try {
    writeFileSync(join(dir, 'keyring.gpg'), Buffer.concat(keys.map(dearmor)))
    writeFileSync(join(dir, 'SHASUMS256.txt'), data)
    writeFileSync(join(dir, 'SHASUMS256.txt.sig'), sig)
    const r = spawnSync(
      gpgv,
      ['--homedir', dir, '--keyring', join(dir, 'keyring.gpg'), '--status-fd', '1', join(dir, 'SHASUMS256.txt.sig'), join(dir, 'SHASUMS256.txt')],
      { encoding: 'utf8' },
    )
    if (r.error) throw new Error(`could not run ${gpgv} (GnuPG's verify tool): ${r.error.message}`)
    const signer = r.status === 0 ? validSigner(r.stdout) : null
    if (!signer) throw new Error(`the signature on SHASUMS256.txt does not verify:\n${r.stderr.trim()}`)
    return signer
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function fetchOk(url, as = 'text') {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return as === 'bytes' ? Buffer.from(await res.arrayBuffer()) : await res.text()
}

const keyUrl = (commit, fpr) => `https://raw.githubusercontent.com/nodejs/release-keys/${commit}/keys/${fpr}.asc`

/** The signed SHASUMS256.txt of a version, checked with `keys` (fingerprints at that release-keys commit) */
async function signedShasums(version, commit, fingerprints) {
  const base = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`
  const [data, sig, keys] = await Promise.all([
    fetchOk(base),
    fetchOk(`${base}.sig`, 'bytes'),
    Promise.all(fingerprints.map((f) => fetchOk(keyUrl(commit, f)))),
  ])
  const signer = verifyDetached({ data, sig, keys })
  return { data, signer }
}

async function main(argv) {
  const at = argv.indexOf('--set')
  if (at === -1) {
    const pin = readPin()
    const { version, signedBy, releaseKeys } = pin.node
    const { data, signer } = await signedShasums(version, releaseKeys, [signedBy])
    if (signer !== signedBy) throw new Error(`SHASUMS256.txt of Node ${version} is signed by ${signer}, not by the pinned ${signedBy}`)
    const problems = pinProblems(pin, data)
    if (problems.length) throw new Error(`the pinned Node does not match its signed SHASUMS256.txt:\n  ${problems.join('\n  ')}`)
    console.log(`Node ${version}: ${Object.keys(pin.node.archives).length} archives match SHASUMS256.txt, signed by ${signer}`)
    return
  }
  const version = argv[at + 1]
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('--set needs an exact version, such as 24.22.0')
  // The newest key list, by the commit it is at now; every listed key may have signed this release
  const commit = argv.includes('--release-keys')
    ? argv[argv.indexOf('--release-keys') + 1]
    : JSON.parse(await fetchOk('https://api.github.com/repos/nodejs/release-keys/commits/main')).sha
  const fingerprints = (await fetchOk(`https://raw.githubusercontent.com/nodejs/release-keys/${commit}/keys.list`))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => HEX40.test(l))
  const { data, signer } = await signedShasums(version, commit, fingerprints)
  const pin = pinFrom(version, data, { signedBy: signer, releaseKeys: commit })
  writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, 2)}\n`)
  console.log(`pinned Node ${version} (signed by ${signer}, release-keys ${commit}) in ${PIN_FILE}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`node-pin: ${e.message}`)
    process.exit(1)
  })
}
