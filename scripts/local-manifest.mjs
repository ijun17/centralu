/** Data-only policy for local signing; also used by the command before dispatch. */
import { Buffer } from 'node:buffer'
import { isNewer } from '../packaging/npm/centralu/bin/semver.mjs'
import { releaseTag, ROOT } from './app-version.mjs'

export const MAX_LOCAL_MANIFEST_BYTES = 60_000
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function checkVersion(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('invalid version')
  const [core, ...pre] = version.split('-')
  if (core.split('.').some((n) => !Number.isSafeInteger(Number(n)))) throw new Error('version number too large')
  for (const id of pre.join('-').split('.')) {
    if (/^\d+$/.test(id) && (!Number.isSafeInteger(Number(id)) || /^0\d/.test(id))) throw new Error('invalid numeric prerelease')
  }
}

export function nextReleaseVersion(base) {
  checkVersion(base)
  if (/[.-]local\.\d+$/.test(base)) throw new Error('base must be a release version')
  const match = /^(.*[.-])(\d+)$/.exec(base)
  if (!match) throw new Error('release version must end in a numeric identifier')
  const next = `${match[1]}${Number(match[2]) + 1}`
  checkVersion(next)
  return next
}

export function assertLocalVersion(version, base, installed) {
  checkVersion(version)
  checkVersion(installed)
  const next = nextReleaseVersion(base)
  const prefix = `${base}.local.`
  const n = version.startsWith(prefix) ? version.slice(prefix.length) : ''
  if (!/^[1-9]\d*$/.test(n) || !Number.isSafeInteger(Number(n))) throw new Error('version must be <base>.local.N with positive N')
  if (!isNewer(version, installed) || !isNewer(next, version)) throw new Error('local version must be above installed and below next release')
  return next
}

export function chooseLocalVersion(base, installed, requested) {
  const prefix = `${base}.local.`
  const previous = installed.startsWith(prefix) ? Number(installed.slice(prefix.length)) : 0
  const version = requested ?? `${prefix}${previous + 1}`
  assertLocalVersion(version, base, installed)
  return version
}

/**
 * The release a local build is cut from: the newest release tag reachable from the checkout's HEAD
 * (#1501; git holds no version in a file). Read from trusted checkout data, never from an uploaded
 * manifest; the checkout must have its tags (the signing workflow fetches the whole history).
 */
export function readReleaseBase(cwd = ROOT) {
  const tag = releaseTag(cwd)
  if (!tag) throw new Error('no release tag (v*) is reachable from the checkout, so there is no base version; fetch the tags')
  checkVersion(tag)
  return tag
}

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}
function fields(value, expected, name) {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`unexpected ${name} fields`)
}

export function validateLocalManifest(bytes, appVersion) {
  checkVersion(appVersion)
  if (bytes.length === 0 || bytes.length > MAX_LOCAL_MANIFEST_BYTES) throw new Error('local manifest exceeds input size limit')
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) throw new Error('manifest must be UTF-8')
  const m = record(JSON.parse(text), 'manifest')
  fields(m, ['format', 'appVersion', 'platform', 'minShellVersion', 'files', 'local'], 'manifest')
  if (m.format !== 1 || m.platform !== 'darwin-arm64' || m.minShellVersion !== 1) throw new Error('only format 1, shell 1, darwin-arm64 content is allowed')
  const local = record(m.local, 'local provenance')
  fields(local, ['baseVersion', 'installedVersion', 'nextRelease', 'commit', 'dirty', 'requestId'], 'provenance')
  if (typeof local.requestId !== 'string' || !/^[0-9a-f]{32}$/.test(local.requestId)) throw new Error('request id is required')
  if (typeof local.commit !== 'string' || !/^[0-9a-f]{40}$/.test(local.commit) || typeof local.dirty !== 'boolean') throw new Error('commit and dirty flag are required')
  if (local.baseVersion !== appVersion) throw new Error('local baseVersion must match the release tag of the checkout')
  if (assertLocalVersion(m.appVersion, appVersion, local.installedVersion) !== local.nextRelease) throw new Error('incorrect next release')
  if (!Array.isArray(m.files) || m.files.length < 2) throw new Error('content files are required')
  const seen = new Set()
  let previous = ''
  for (const raw of m.files) {
    const f = record(raw, 'file')
    fields(f, ['path', 'size', 'sha256', 'executable'], 'file')
    // Narrower than the verifier: only the keeper and files inside host/ may be signed.
    // eslint-disable-next-line no-control-regex
    if (typeof f.path !== 'string' || /[\\\u0000-\u001f\u007f]/.test(f.path) || f.path.split('/').some((p) => !p || p === '.' || p === '..') || !(f.path === 'centralu-keeper' || f.path.startsWith('host/'))) throw new Error('unexpected content path')
    if (!Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || typeof f.executable !== 'boolean') throw new Error('invalid file metadata')
    const folded = f.path.replace(/[A-Z]/g, (c) => c.toLowerCase())
    if (seen.has(folded) || Buffer.compare(Buffer.from(previous), Buffer.from(f.path)) >= 0) throw new Error('files must be unique and sorted by UTF-8 bytes')
    seen.add(folded)
    previous = f.path
  }
  for (const f of m.files) {
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/').replace(/[A-Z]/g, (c) => c.toLowerCase()))) throw new Error('file is also a directory')
    }
  }
  for (const path of ['centralu-keeper', 'host/main.mjs', 'host/bundle-info.json', 'host/schema.sql', 'host/node_modules/better-sqlite3/package.json', 'host/node_modules/node-pty/package.json']) {
    if (!m.files.some((f) => f.path === path)) throw new Error(`required file missing: ${path}`)
  }
  if (!m.files.find((f) => f.path === 'centralu-keeper').executable) throw new Error('keeper must be executable')
  return m
}
