/**
 * The content manifest writer (scripts/content-manifest.mts), and its agreement with the Rust
 * verifier in apps/desktop/content-verify.
 *
 * The writer's fixture there was signed by this writer; the crate's tests/writer.rs verifies it
 * and copies it byte for byte. The first test here holds the writer to the same bytes, so a change
 * to either side that the other does not follow fails one of the two suites.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MANIFEST_NAME,
  assertNoCaseCollisions,
  SIGNATURE_NAME,
  buildManifest,
  keyIdOf,
  pathProblem,
  publicKeyFromRaw,
  rawPublicKey,
  resolveSigningKey,
  throwawayKey,
  trustedKeys,
  verifyContent,
  verifyManifest,
  writeContentManifest,
  type TrustedKey,
} from '../scripts/content-manifest.mjs'

const FIXTURE = fileURLToPath(new URL('../apps/desktop/content-verify/tests/fixtures/', import.meta.url))
const WRITER = join(FIXTURE, 'writer')
const fixtureKey: TrustedKey[] = (() => {
  const publicKey = publicKeyFromRaw(Buffer.from(readFileSync(join(WRITER, 'key.pub'), 'utf8').trim(), 'base64'))
  return [{ name: 'writer fixture', keyId: keyIdOf(publicKey), publicKey }]
})()

const temps: string[] = []
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'content-manifest-'))
  temps.push(d)
  return d
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function put(dir: string, rel: string, bytes: string | Buffer, mode = 0o644) {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), bytes)
  chmodSync(join(dir, rel), mode)
}

const opts = { appVersion: '0.1.0-beta.12', platform: 'test-platform' }

describe('the writer and the Rust verifier agree', () => {
  // The fixture's executable bit does not survive a Windows checkout, and nothing signs there.
  it.skipIf(process.platform === 'win32')('the writer produces exactly the manifest bytes the Rust fixture verifies', () => {
    const dir = join(WRITER, 'content')
    const committed = readFileSync(join(dir, MANIFEST_NAME))
    expect(buildManifest(dir, { appVersion: '0.0.0-fixture.1', platform: 'darwin-arm64' }).equals(committed)).toBe(true)
  })

  it('the fixture verifies in Node under its own key and not under keys.json', () => {
    const dir = join(WRITER, 'content')
    expect(verifyContent(dir, { keys: fixtureKey, platform: 'darwin-arm64' }).files).toHaveLength(6)
    expect(() => verifyContent(dir)).toThrow(/unknown key/)
  })

  it('both sides apply the same path rules (tests/fixtures/paths.json)', () => {
    const table = JSON.parse(readFileSync(join(FIXTURE, 'paths.json'), 'utf8')) as { path: string; ok: boolean }[]
    expect(table.length).toBeGreaterThan(20)
    for (const { path, ok } of table) expect(pathProblem(path) === null, JSON.stringify(path)).toBe(ok)
  })
})

describe('keys', () => {
  it('keys.json holds two distinct ed25519 keys, current and next, whose ids are sha256 prefixes', () => {
    const keys = trustedKeys()
    expect(keys.map((k) => k.name)).toEqual(['current', 'next'])
    for (const k of keys) {
      expect(k.keyId).toMatch(/^[0-9a-f]{16}$/)
      expect(k.keyId).toBe(createHash('sha256').update(rawPublicKey(k.publicKey)).digest('hex').slice(0, 16))
    }
    expect(keys[0]!.keyId).not.toBe(keys[1]!.keyId)
  })

  it('a dry run signs with a throwaway key even when a key is present, and so does a missing key', () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    for (const k of [
      resolveSigningKey({ dryRun: true, pem }),
      resolveSigningKey({ dryRun: false, pem: undefined }),
      resolveSigningKey({ dryRun: false, pem: '  \n' }),
    ]) {
      expect(k.throwaway).toBe(true)
    }
    const real = resolveSigningKey({ dryRun: false, pem })
    expect(real.throwaway).toBe(false)
    expect(real.keyId).toBe(keyIdOf(real.publicKey))
  })

  it('a key that is not an ed25519 PEM is an error that does not repeat the input', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    expect(() => resolveSigningKey({ dryRun: false, pem: rsa })).toThrow(/not ed25519/)
    const secret = 'SECRET-LOOKING-INPUT-1234'
    let message = ''
    try {
      resolveSigningKey({ dryRun: false, pem: secret })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/not a PEM private key/)
    expect(message).not.toContain(secret)
  })

  it('what a throwaway key signs never verifies against keys.json, and says it is a throwaway', () => {
    const dir = temp()
    put(dir, 'a', 'a')
    for (let i = 0; i < 16; i++) {
      const key = throwawayKey()
      const { manifest, signature } = writeContentManifest(dir, opts, key)
      expect(() => verifyManifest(manifest, signature, { keys: trustedKeys() })).toThrow(/unknown key/)
      expect(JSON.parse(signature.toString('utf8')).comment).toMatch(/throwaway/)
    }
  })

  it('the signature file carries the public key id and the signature, never the private key', () => {
    const dir = temp()
    put(dir, 'a', 'a')
    const key = throwawayKey()
    const { manifest, signature } = writeContentManifest(dir, opts, key)
    const sig = JSON.parse(signature.toString('utf8')) as Record<string, unknown>
    expect(Object.keys(sig).sort()).toEqual(['algorithm', 'comment', 'format', 'keyId', 'signature'])
    const secret = key.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
    for (const out of [manifest, signature, readFileSync(join(dir, SIGNATURE_NAME))]) {
      expect(out.includes(secret)).toBe(false)
      expect(out.includes(Buffer.from(secret.toString('base64')))).toBe(false)
    }
  })
})

describe('the manifest', () => {
  function signed(files: Record<string, string | Buffer>) {
    const dir = temp()
    for (const [rel, bytes] of Object.entries(files)) put(dir, rel, bytes, rel.endsWith('.sh') ? 0o755 : 0o644)
    const key = throwawayKey()
    const out = writeContentManifest(dir, opts, key)
    const keys: TrustedKey[] = [{ name: 'test', keyId: key.keyId, publicKey: key.publicKey }]
    return { dir, keys, ...out }
  }

  // Windows has no exec bit to read.
  it.skipIf(process.platform === 'win32')('lists every regular file with its size, hash and exec bit, sorted by bytes', () => {
    const { manifest } = signed({ 'b.sh': '#!/bin/sh\n', 'B': 'upper', '_': '', 'a/z': 'z', 'a/y/x': 'x' })
    const m = JSON.parse(manifest.toString('utf8'))
    expect(Object.keys(m)).toEqual(['format', 'appVersion', 'platform', 'minShellVersion', 'files'])
    expect(m.format).toBe(1)
    expect(m.minShellVersion).toBe(1)
    expect(m.files.map((f: { path: string }) => f.path)).toEqual(['B', '_', 'a/y/x', 'a/z', 'b.sh'])
    const sh = m.files.find((f: { path: string }) => f.path === 'b.sh')
    expect(sh).toEqual({ path: 'b.sh', size: 10, sha256: createHash('sha256').update('#!/bin/sh\n').digest('hex'), executable: true })
    expect(m.files.find((f: { path: string }) => f.path === '_').size).toBe(0)
    expect(manifest.toString('utf8').endsWith('}\n')).toBe(true)
  })

  it('writing again over the same folder gives the same manifest (its own files are not content)', () => {
    const { dir, manifest } = signed({ a: 'a' })
    expect(buildManifest(dir, opts).equals(manifest)).toBe(true)
  })

  it('verifies, with a large file and many files', () => {
    const files: Record<string, string | Buffer> = { big: Buffer.alloc(6 * 1024 * 1024 + 3, 7) }
    for (let i = 0; i < 500; i++) files[`d${i % 13}/f${i}`] = `file ${i}`
    const { dir, keys } = signed(files)
    expect(verifyContent(dir, { keys }).files).toHaveLength(501)
  })

  it('flipping any byte of the manifest is refused', () => {
    const { manifest, signature, keys } = signed({ 'a.sh': 'x', b: '' })
    for (let i = 0; i < manifest.length; i++) {
      const t = Buffer.from(manifest)
      t[i] = t[i]! ^ 0x01
      expect(() => verifyManifest(t, signature, { keys }), `byte ${i}`).toThrow(/bad signature/)
    }
  })

  it('flipping any byte of the signature itself is refused', () => {
    const { manifest, signature, keys } = signed({ a: 'x' })
    const sig = JSON.parse(signature.toString('utf8'))
    const raw = Buffer.from(sig.signature, 'base64')
    for (let i = 0; i < raw.length; i++) {
      const t = Buffer.from(raw)
      t[i] = t[i]! ^ 0x01
      const file = Buffer.from(JSON.stringify({ ...sig, signature: t.toString('base64') }))
      expect(() => verifyManifest(manifest, file, { keys }), `byte ${i}`).toThrow(/bad signature/)
    }
  })

  it('changing, truncating or extending a file is refused', () => {
    const { dir, keys } = signed({ f: 'abcdefgh' })
    for (let i = 0; i < 8; i++) {
      const t = Buffer.from('abcdefgh')
      t[i] = t[i]! ^ 0x01
      writeFileSync(join(dir, 'f'), t)
      expect(() => verifyContent(dir, { keys }), `byte ${i}`).toThrow(/does not match its hash/)
    }
    for (const bytes of ['abcdefg', '', 'abcdefghi']) {
      writeFileSync(join(dir, 'f'), bytes)
      expect(() => verifyContent(dir, { keys }), bytes).toThrow(/bytes, the manifest says 8/)
    }
  })

  it('a manifest for another platform or a missing signature is refused', () => {
    const { dir, keys } = signed({ a: 'a' })
    expect(() => verifyContent(dir, { keys, platform: 'linux-x64' })).toThrow(/not linux-x64/)
    rmSync(join(dir, SIGNATURE_NAME))
    expect(() => verifyContent(dir, { keys })).toThrow(/missing/)
  })
})

describe('the writer refuses what the verifier would refuse', () => {
  it.skipIf(process.platform === 'win32')('a symlink', () => {
    const dir = temp()
    put(dir, 'real', 'x')
    symlinkSync('real', join(dir, 'link'))
    expect(() => buildManifest(dir, opts)).toThrow(/symlink/)
  })

  it.skipIf(process.platform === 'win32')('a name with a backslash or a control character', () => {
    for (const name of ['a\\b', 'a\nb']) {
      const dir = temp()
      put(dir, name, 'x')
      expect(() => buildManifest(dir, opts), JSON.stringify(name)).toThrow(/cannot be content/)
    }
  })

  it('two names that differ only in ASCII case', () => {
    expect(() => assertNoCaseCollisions(['host/Main.mjs', 'host/main.mjs'])).toThrow(/differ only in case/)
    expect(() => assertNoCaseCollisions(['HOST/x', 'host/x'])).toThrow(/differ only in case/)
    // ASCII only, as the Rust verifier folds: these are two names to it as well.
    expect(() => assertNoCaseCollisions(['\u00c9', '\u00e9', 'a/x', 'b/x'])).not.toThrow()
  })

  it('two names that differ only in case, where the filesystem can hold both', () => {
    const dir = temp()
    put(dir, 'Main.mjs', 'x')
    put(dir, 'main.mjs', 'y')
    const both = existsSync(join(dir, 'Main.mjs')) && readFileSync(join(dir, 'Main.mjs'), 'utf8') === 'x'
    if (both) expect(() => buildManifest(dir, opts)).toThrow(/differ only in case/)
    else expect(buildManifest(dir, opts).toString()).toContain('"Main.mjs"')
  })
})
