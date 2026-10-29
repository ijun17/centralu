/**
 * The key-pairing test vector, produced apart from `packages/agent-host/src/transport/link-keys.ts` (#1711,
 * docs/plans/key-pairing.md §4.3): its own RFC 8032 Ed25519 on BigInt, with `node:crypto` used only for SHA-256, SHA-512
 * and HMAC, never for a curve. `tooling/key-pairing-vector.test.ts` runs it against the module on every test run; run it
 * by hand to print the vector: `node tooling/key-pairing-vector.mjs`.
 */
import { Buffer } from 'node:buffer'
import { createHash, createHmac } from 'node:crypto'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const p = 2n ** 255n - 19n
const L = 2n ** 252n + 27742317777372353535851937790883648493n
const mod = (a, m = p) => ((a % m) + m) % m
const pow = (b, e, m = p) => {
  let r = 1n
  for (b = mod(b, m); e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m
  return r
}
const inv = (a) => pow(a, p - 2n)
const d = mod(-121665n * inv(121666n))

// Affine points (x, y); the unified addition law of the twisted Edwards curve -x² + y² = 1 + d·x²·y²
const add = ([x1, y1], [x2, y2]) => {
  const t = mod(d * x1 * x2 * y1 * y2)
  return [mod((x1 * y2 + x2 * y1) * inv(1n + t)), mod((y1 * y2 + x1 * x2) * inv(1n - t))]
}
const mul = (k, pt) => {
  let r = [0n, 1n]
  for (; k > 0n; k >>= 1n, pt = add(pt, pt)) if (k & 1n) r = add(r, pt)
  return r
}
const baseY = mod(4n * inv(5n))
const baseX2 = mod((baseY * baseY - 1n) * inv(d * baseY * baseY + 1n))
let baseX = pow(baseX2, (p + 3n) / 8n)
if (mod(baseX * baseX - baseX2) !== 0n) baseX = mod(baseX * pow(2n, (p - 1n) / 4n))
if (baseX % 2n !== 0n) baseX = p - baseX
const B = [baseX, baseY]

const le = (n, len) => {
  const b = Buffer.alloc(len)
  for (let i = 0; i < len; i++, n >>= 8n) b[i] = Number(n & 0xffn)
  return b
}
const fromLe = (b) => [...b].reduceRight((n, x) => (n << 8n) | BigInt(x), 0n)
const encode = ([x, y]) => {
  const b = le(y, 32)
  if (x & 1n) b[31] |= 0x80
  return b
}
const sha512 = (...parts) => createHash('sha512').update(Buffer.concat(parts)).digest()

function keyOf(seed) {
  const h = sha512(seed)
  const a = fromLe(h.subarray(0, 32).map((x, i) => (i === 0 ? x & 248 : i === 31 ? (x & 127) | 64 : x)))
  return { a, prefix: h.subarray(32), pub: encode(mul(a, B)) }
}
function sign(seed, message) {
  const { a, prefix, pub } = keyOf(seed)
  const r = mod(fromLe(sha512(prefix, message)), L)
  const R = encode(mul(r, B))
  const k = mod(fromLe(sha512(R, pub, message)), L)
  return Buffer.concat([R, le(mod(r + k * a, L), 32)])
}

const field = (b) => Buffer.concat([le(BigInt(b.length), 4).reverse(), b])
const ascii = (s) => Buffer.from(s, 'ascii')

/** The vector of slice 2: the inputs, the bytes of T, and both signatures */
export function vector() {
  const hostKeyText = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
  const hubSeed = Buffer.alloc(32, 0x42)
  const hostSeed = createHmac('sha256', hostKeyText).update('centralu host key v1').digest()
  const hubNonce = Buffer.alloc(24, 0x11)
  const hostNonce = Buffer.alloc(24, 0x22)
  const hostPub = keyOf(hostSeed).pub
  const hubPub = keyOf(hubSeed).pub
  const keyId = 'a1b2c3d4'
  const address = '127.0.0.1:4100'
  const t = Buffer.concat([
    field(ascii('centralu link v1')), field(hubNonce), field(hostNonce), field(hostPub), field(hubPub), field(ascii(keyId)), field(ascii(address)),
  ])
  const signed = (label, seed) => sign(seed, Buffer.concat([field(ascii(label)), t])).toString('base64url')
  return {
    hostKey: hostPub.toString('base64url'),
    hubKey: hubPub.toString('base64url'),
    transcript: t.toString('hex'),
    hubSig: signed('centralu link hub v1', hubSeed),
    hostSig: signed('centralu link host v1', hostSeed),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.stdout.write(`${JSON.stringify(vector(), null, 2)}
`)
