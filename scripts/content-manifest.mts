/**
 * The signed content manifest (docs/plans/thin-shell.md §4): the release side.
 *
 * A content directory is everything the keeper and the host need to run. This module writes
 * `content-manifest.json` into it (the app version, the platform, the minimum shell version, and
 * every regular file with its size, sha256 and executable bit) and a detached ed25519 signature
 * over the exact bytes of that file, `content-manifest.json.sig`. The verifier that decides
 * whether to run the content is the Rust crate in `apps/desktop/content-verify`; `verifyContent`
 * below is the Node mirror of it, used by tests and by the release script to check its own output.
 *
 * Formats (the crate's README-less doc comment in src/lib.rs repeats them; change both together):
 *
 *   content-manifest.json  JSON, two-space indented, one trailing newline. `format` is 1.
 *                          `files` is sorted by path (byte order of the UTF-8 encoding). A path is
 *                          relative, `/`-separated, with no empty, `.` or `..` component, no `\`
 *                          and no control character. Directories are implied by the files in them;
 *                          an empty directory is not content. Unknown fields are ignored by the
 *                          verifier: a change old verifiers must not ignore bumps `format`.
 *   content-manifest.json.sig
 *                          JSON: `format` 1, `algorithm` "ed25519", `keyId`, `signature` (base64
 *                          of the 64-byte signature over the manifest file's bytes, nothing
 *                          prepended), and `comment`, which is for people and verifies nothing.
 *   key id                 the first 8 bytes of SHA-256 over the raw 32-byte public key, as 16
 *                          lowercase hex characters. It picks the key; it is not the trust.
 *
 * Not minisign, which §4 first named: minisign prehashes with BLAKE2b and signs a second "trusted
 * comment", and its key ids are random bytes kept in minisign key files. The keys were generated
 * as plain ed25519 (PKCS#8) straight into the release environment, and the verifier's whole
 * dependency list is meant to be an ed25519 check and a hash. Nobody needs the minisign tool to
 * read these: `tsx scripts/content-manifest.mts verify <dir>` does.
 *
 * **The private key is never printed, logged or written.** It is read from the environment
 * (`CONTENT_SIGNING_KEY`, PKCS#8 PEM) or generated in memory for a dry run, and only its public
 * half and its id ever leave this module.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST_NAME = 'content-manifest.json'
export const SIGNATURE_NAME = 'content-manifest.json.sig'
export const MANIFEST_FORMAT = 1
/**
 * The shell version this content needs. 1 is the first shell (docs/plans/thin-shell.md §7); it
 * goes up only when the window–shell or shell–keeper contract changes.
 */
export const MIN_SHELL_VERSION = 1

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const KEYS_FILE = join(ROOT, 'packaging/shell/keys.json')

export interface ManifestFile {
  path: string
  size: number
  sha256: string
  executable: boolean
}

export interface Manifest {
  format: number
  appVersion: string
  platform: string
  minShellVersion: number
  files: ManifestFile[]
}

export interface SignatureFile {
  format: number
  algorithm: string
  keyId: string
  signature: string
  comment?: string
}

export interface SigningKey {
  privateKey: KeyObject
  publicKey: KeyObject
  keyId: string
  /** Generated in memory for this run: in no keys.json, so nothing will ever accept what it signs. */
  throwaway: boolean
}

export interface TrustedKey {
  name: string
  keyId: string
  publicKey: KeyObject
}

/** Raw 32-byte ed25519 public key of a KeyObject. */
export function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' })
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('not an ed25519 key')
  return Buffer.from(jwk.x, 'base64url')
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error(`an ed25519 public key is 32 bytes, not ${raw.length}`)
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
}

export function keyIdOf(publicKey: KeyObject): string {
  return createHash('sha256').update(rawPublicKey(publicKey)).digest().subarray(0, 8).toString('hex')
}

/** The keys a shell built from this commit would trust (packaging/shell/keys.json). */
export function trustedKeys(file = KEYS_FILE): TrustedKey[] {
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  return (['current', 'next'] as const).map((name) => {
    const value = json[name]
    if (typeof value !== 'string') throw new Error(`${file} has no "${name}" key`)
    const publicKey = publicKeyFromRaw(Buffer.from(value, 'base64'))
    return { name, keyId: keyIdOf(publicKey), publicKey }
  })
}

/** An in-memory key for a dry run. Not exported anywhere, gone when the process exits. */
export function throwawayKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey, keyId: keyIdOf(publicKey), throwaway: true }
}

/**
 * The release key from `CONTENT_SIGNING_KEY` (PKCS#8 PEM), or a throwaway key in a dry run or
 * when the variable is absent. A present but unreadable key is an error, not a fallback: a
 * release that meant to sign must not quietly sign with something else.
 */
export function resolveSigningKey(opts: { dryRun: boolean; pem: string | undefined }): SigningKey {
  if (opts.dryRun || !opts.pem?.trim()) return throwawayKey()
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey({ key: opts.pem, format: 'pem' })
  } catch {
    // The parser's message is dropped on purpose: it should not echo any of the input.
    throw new Error('CONTENT_SIGNING_KEY is set but is not a PEM private key')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`CONTENT_SIGNING_KEY is a ${privateKey.asymmetricKeyType ?? 'unknown'} key, not ed25519`)
  }
  const publicKey = createPublicKey(privateKey)
  return { privateKey, publicKey, keyId: keyIdOf(publicKey), throwaway: false }
}

/**
 * Why a path cannot be content, or null. The same rules as `check_path` in the Rust crate;
 * the writer refuses what the verifier would refuse, so a bad name fails the release, not a
 * person's start.
 */
export function pathProblem(path: string): string | null {
  if (path === '') return 'empty'
  if (path.startsWith('/')) return 'absolute'
  if (path.includes('\\')) return 'contains a backslash'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'contains a control character'
  for (const part of path.split('/')) {
    if (part === '') return 'has an empty component'
    if (part === '.' || part === '..') return `has a "${part}" component`
  }
  if (path === MANIFEST_NAME || path === SIGNATURE_NAME) return 'is the manifest or its signature'
  return null
}

/** ASCII case folding only, as `to_ascii_lowercase` in the Rust crate. */
export function foldAscii(path: string): string {
  return path.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Every regular file under `dir` (the manifest and its signature at the top excepted). */
export function listContent(dir: string): ManifestFile[] {
  const files: ManifestFile[] = []
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel === '' ? name : `${rel}/${name}`
      if (rel === '' && (name === MANIFEST_NAME || name === SIGNATURE_NAME)) continue
      const problem = pathProblem(path)
      if (problem) throw new Error(`cannot be content: ${JSON.stringify(path)} ${problem}`)
      const st = lstatSync(join(dir, path))
      if (st.isSymbolicLink()) throw new Error(`cannot be content: ${path} is a symlink (the verifier refuses them)`)
      if (st.isDirectory()) {
        walk(path)
        continue
      }
      if (!st.isFile()) throw new Error(`cannot be content: ${path} is not a regular file`)
      const bytes = readFileSync(join(dir, path))
      files.push({
        path,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        executable: (st.mode & 0o111) !== 0,
      })
    }
  }
  walk('')
  assertNoCaseCollisions(files.map((f) => f.path))
  return files.sort((a, b) => byteOrder(a.path, b.path))
}

/**
 * Two paths that differ only in ASCII case are one file on a default (case-insensitive) APFS
 * volume, so the verifier refuses them; refuse them here, on whatever filesystem this runs.
 */
export function assertNoCaseCollisions(paths: string[]): void {
  const seen = new Map<string, string>()
  for (const path of paths) {
    const folded = foldAscii(path)
    const other = seen.get(folded)
    if (other !== undefined) throw new Error(`cannot be content: ${other} and ${path} differ only in case`)
    seen.set(folded, path)
  }
}

export function manifestBytes(m: Manifest): Buffer {
  // Field order is fixed here rather than taken from the caller's object.
  const ordered: Manifest = {
    format: m.format,
    appVersion: m.appVersion,
    platform: m.platform,
    minShellVersion: m.minShellVersion,
    files: m.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, executable: f.executable })),
  }
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
}

export function buildManifest(
  dir: string,
  opts: { appVersion: string; platform: string; minShellVersion?: number },
): Buffer {
  return manifestBytes({
    format: MANIFEST_FORMAT,
    appVersion: opts.appVersion,
    platform: opts.platform,
    minShellVersion: opts.minShellVersion ?? MIN_SHELL_VERSION,
    files: listContent(dir),
  })
}

export function signatureBytes(manifest: Buffer, key: SigningKey, keys: TrustedKey[] = trustedKeys()): Buffer {
  const named = keys.find((k) => k.keyId === key.keyId)?.name
  const comment = key.throwaway
    ? 'throwaway key generated in memory for a dry run: it is in no keys.json and nothing will accept it'
    : named
      ? `release key "${named}" in packaging/shell/keys.json`
      : 'a key that is not in packaging/shell/keys.json'
  const file: SignatureFile = {
    format: MANIFEST_FORMAT,
    algorithm: 'ed25519',
    keyId: key.keyId,
    signature: sign(null, manifest, key.privateKey).toString('base64'),
    comment,
  }
  return Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
}

/** Write the manifest and its signature into `dir`. Returns both, as written. */
export function writeContentManifest(
  dir: string,
  opts: { appVersion: string; platform: string; minShellVersion?: number },
  key: SigningKey,
  keys?: TrustedKey[],
): { manifest: Buffer; signature: Buffer } {
  const manifest = buildManifest(dir, opts)
  const signature = signatureBytes(manifest, key, keys)
  writeFileSync(join(dir, MANIFEST_NAME), manifest)
  writeFileSync(join(dir, SIGNATURE_NAME), signature)
  return { manifest, signature }
}

export class ContentError extends Error {}

/** Check a signature file against the trusted keys; returns the parsed manifest. */
export function verifyManifest(
  manifest: Buffer,
  signature: Buffer,
  opts: { keys: TrustedKey[]; platform?: string },
): Manifest {
  let sig: SignatureFile
  try {
    sig = JSON.parse(signature.toString('utf8')) as SignatureFile
  } catch {
    throw new ContentError('signature file is not JSON')
  }
  if (sig.format !== MANIFEST_FORMAT || sig.algorithm !== 'ed25519') throw new ContentError('unsupported signature format')
  const key = opts.keys.find((k) => k.keyId === sig.keyId)
  if (!key) throw new ContentError(`signed with an unknown key ${String(sig.keyId)}`)
  const raw = Buffer.from(String(sig.signature), 'base64')
  if (raw.length !== 64 || raw.toString('base64') !== sig.signature) throw new ContentError('signature is not 64 bytes of base64')
  if (!verify(null, manifest, key.publicKey, raw)) throw new ContentError('bad signature')
  const parsed = JSON.parse(manifest.toString('utf8')) as Manifest
  if (parsed.format !== MANIFEST_FORMAT) throw new ContentError(`unsupported manifest format ${parsed.format}`)
  if (opts.platform !== undefined && parsed.platform !== opts.platform) {
    throw new ContentError(`manifest is for ${parsed.platform}, not ${opts.platform}`)
  }
  const seen = new Set<string>()
  for (const f of parsed.files) {
    const problem = pathProblem(f.path)
    if (problem) throw new ContentError(`bad path ${JSON.stringify(f.path)}: ${problem}`)
    if (seen.has(foldAscii(f.path))) throw new ContentError(`duplicate path ${f.path}`)
    seen.add(foldAscii(f.path))
  }
  return parsed
}

/**
 * The Node mirror of the Rust verifier, for tests and for the release script's own check. It
 * reads the files by path and is not free of check-then-use races; what runs is decided by the
 * Rust crate, which hashes the bytes it copies.
 */
export function verifyContent(dir: string, opts: { keys?: TrustedKey[]; platform?: string } = {}): Manifest {
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name))
    } catch {
      throw new ContentError(`${name} is missing`)
    }
  }
  const manifest = verifyManifest(read(MANIFEST_NAME), read(SIGNATURE_NAME), {
    keys: opts.keys ?? trustedKeys(),
    platform: opts.platform,
  })
  for (const f of manifest.files) {
    const st = lstatSync(join(dir, f.path), { throwIfNoEntry: false })
    if (!st?.isFile()) throw new ContentError(`${f.path} is missing or not a regular file`)
    const bytes = readFileSync(join(dir, f.path))
    if (bytes.length !== f.size) throw new ContentError(`${f.path} is ${bytes.length} bytes, the manifest says ${f.size}`)
    if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw new ContentError(`${f.path} does not match its hash`)
  }
  return manifest
}

/*
 * Command line, for a person checking a release by hand and for regenerating the Rust crate's
 * fixture:
 *
 *   tsx scripts/content-manifest.mts sign <dir> --app-version <v> [--platform <p>] [--min-shell-version <n>]
 *   tsx scripts/content-manifest.mts verify <dir> [--platform <p>]
 *
 * `sign` uses CONTENT_SIGNING_KEY when it is set, and a throwaway key otherwise.
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, dir] = process.argv.slice(2)
  const flag = (name: string) => {
    const i = process.argv.indexOf(name)
    return i === -1 ? undefined : process.argv[i + 1]
  }
  const platform = flag('--platform')
  if (command === 'sign' && dir) {
    const appVersion = flag('--app-version')
    if (!appVersion) throw new Error('--app-version is required')
    const pem = process.env.CONTENT_SIGNING_KEY
    delete process.env.CONTENT_SIGNING_KEY
    const key = resolveSigningKey({ dryRun: false, pem })
    const min = flag('--min-shell-version')
    writeContentManifest(dir, {
      appVersion,
      platform: platform ?? `${process.platform}-${process.arch}`,
      minShellVersion: min === undefined ? undefined : Number(min),
    }, key)
    console.log(`signed ${join(dir, MANIFEST_NAME)} with key ${key.keyId}${key.throwaway ? ' (throwaway)' : ''}`)
    console.log(`public key: ${rawPublicKey(key.publicKey).toString('base64')}`)
  } else if (command === 'verify' && dir) {
    const m = verifyContent(dir, { platform })
    console.log(`ok: ${m.appVersion} ${m.platform}, ${m.files.length} files`)
  } else {
    console.error('usage: content-manifest.mts sign <dir> --app-version <v> | verify <dir>')
    process.exit(2)
  }
}
