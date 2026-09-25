import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wireJoin, wireSegments, type AppReview } from '@cc/protocol'
import { assertExistingPathSync } from '../../dev-services/path-guard.js'
import { proposedMcpServerNameError } from '../contract.js'
import { reviewKey } from './import-book.js'
import { MANIFEST_FILE, MAX_MANIFEST_BYTES, parseManifest, type AppManifest } from './manifest.js'
import { ZipError, readZipEntries, readZipEntry, type ZipEntry } from './zip.js'

/**
 * 밖에서 앱을 가져온다 (M4 E-3) — 폴더나 zip(이 기계의 파일이거나 https 주소)을 **따지며 옮겨 담고**, 사람이 볼 것을 만든다.
 *
 * 이 파일은 옮겨 담기까지만 한다. 담는 곳은 부른 쪽이 준 빈 폴더(데이터 폴더의 대기실)이고, 그것을 사용자 폴더로 옮기는 일과
 * 사람의 확인은 런타임의 문이 한다(`runtime.ts`의 건네기). 대기실은 발견이 훑는 자리가 아니라서, 판정이 끝나기 전의 앱을 누구도
 * 띄우거나 세션에 붙이지 않는다.
 *
 * 무엇을 막나:
 *   - **링크를 따라가지 않는다.** 폴더 안의 링크가 폴더 밖을 가리키면 가져오기를 거절한다(무엇을 가리키는지 말한다). 안을 가리키는
 *     링크는 옮기지 않고 목록에 적는다. zip의 링크 항목도 같다 — 링크를 풀어 두는 것이 zip slip의 가장 오래된 길이다.
 *   - **이름으로 밖에 쓰지 않는다(zip slip).** 절대 경로, `..`, 역슬래시, 드라이브 문자, 빈 칸, 제어 문자는 거절한다. 쓰는 경로는
 *     검사를 통과한 칸들로만 만든다.
 *   - **크기.** 파일 수, 합계, 파일 하나, 깊이, 묶음 자체의 크기에 상한이 있다. zip은 선언한 크기로 먼저 재고, 풀 때 선언을 넘으면
 *     멈춘다(`zip.ts`).
 *   - **점으로 시작하는 이름은 옮기지 않는다.** `.git`, `.env`, 그리고 `.claude/`·`.codex/` — 이 둘은 앱 폴더에서 일하는 만드는
 *     세션이 읽는 설정이라, 가져온 묶음이 들고 온 훅이 사람의 확인 없이 돌 수 있다. 폴더 지문(`fingerprint.ts`)도 점 이름을 앱의
 *     동작으로 치지 않는다.
 */

export const IMPORT_LIMITS = {
  /** 옮기는 파일 수 — 지문이 재는 상한(2000)과 같다 */
  files: 2_000,
  /** 옮기는 파일 크기의 합 */
  totalBytes: 64 * 1024 * 1024,
  /** 파일 하나 */
  fileBytes: 16 * 1024 * 1024,
  /** 폴더 깊이 */
  depth: 16,
  /** 경로 하나의 글자 수 */
  pathChars: 1024,
  /** zip 파일 자체 (내려받는 것 포함) */
  archiveBytes: 32 * 1024 * 1024,
  /** 내려받기가 끝나야 하는 시간 */
  downloadMs: 60_000,
  /** 따라가는 https 넘김의 수 */
  redirects: 5,
}
export type ImportLimits = typeof IMPORT_LIMITS

/** 가져오기를 거절한다 — 이유가 곧 사람에게 보이는 말이다 */
export class ImportRefused extends Error {
  readonly code = 'internal'
}

export type ImportSource = { kind: 'path'; path: string; label: string } | { kind: 'https'; url: URL; label: string }

/**
 * 사람이 준 출처 → 가져올 곳. **이 기계의 파일과 https만** 받는다. http는 가는 길에 바뀔 수 있고, 다른 스킴은 무엇을 여는지
 * 우리가 모른다. 경로는 절대 경로만 — 상대 경로는 host의 작업 폴더에 따라 뜻이 바뀐다.
 */
export function classifySource(raw: string): ImportSource {
  const s = raw.trim()
  if (!s) throw new ImportRefused('Choose a folder, a .zip file, or an https link to a .zip')
  if (s.includes('\0')) throw new ImportRefused('The source contains a NUL character')
  if (/^https:/i.test(s)) {
    let url: URL
    try {
      url = new URL(s)
    } catch {
      throw new ImportRefused(`Not a valid link: ${s}`)
    }
    const problem = httpsProblem(url)
    if (problem) throw new ImportRefused(problem)
    return { kind: 'https', url, label: url.href }
  }
  if (/^file:/i.test(s)) {
    let path: string
    try {
      path = fileURLToPath(s)
    } catch {
      throw new ImportRefused(`Only files on this machine can be imported from a file link: ${s}`)
    }
    return { kind: 'path', path, label: path }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) throw new ImportRefused(`Only folders and .zip files on this machine, or https links, can be imported: ${s}`)
  if (!isAbsolute(s)) throw new ImportRefused(`Use the full path of the folder or .zip file: ${s}`)
  return { kind: 'path', path: s, label: s }
}

/**
 * https 주소가 가리키면 안 되는 곳 — 이 기계(루프백), 링크 로컬(클라우드 메타데이터 주소가 여기 있다), 지정되지 않은 주소.
 * 가져오기는 사람이 누른 뒤에만 내려받지만, 누른 것은 링크가 준 주소다. 이름으로 된 호스트가 어디로 풀리는지는 보지 않는다
 * (docs/security-boundaries.md의 한계).
 */
function httpsProblem(url: URL): string | null {
  if (url.protocol !== 'https:') return `Only https links can be downloaded: ${url.href}`
  if (url.username || url.password) return 'Links with a user name or password in them are not accepted'
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return `A link to this machine cannot be downloaded: ${url.href}`
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number]
    if (a === 127 || a === 0 || (a === 169 && b === 254)) return `A link to this machine or a link-local address cannot be downloaded: ${url.href}`
  }
  if (isIP(host) === 6 && (host === '::1' || host === '::' || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'))) {
    return `A link to this machine or a link-local address cannot be downloaded: ${url.href}`
  }
  return null
}

/**
 * https로 zip을 내려받는다 — 넘김은 손으로 따라가며(https만, 상한까지) 매번 주소를 다시 본다. 크기는 `Content-Length`로 먼저,
 * 받는 동안 센 바이트로 한 번 더 막는다(없거나 거짓인 머리가 있다). `dest`는 부른 쪽의 임시 폴더다.
 */
export async function downloadZip(url: URL, dest: string, limits: ImportLimits, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const signal = AbortSignal.timeout(limits.downloadMs)
  let at = url
  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await fetchImpl(at, { redirect: 'manual', signal })
    } catch (e) {
      throw new ImportRefused(`Could not download ${at.href}: ${(e as Error).message}`)
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location')
      if (!to) throw new ImportRefused(`${at.href} redirected without saying where`)
      if (hop >= limits.redirects) throw new ImportRefused(`Too many redirects from ${url.href}`)
      const next = new URL(to, at)
      const problem = httpsProblem(next)
      if (problem) throw new ImportRefused(`${at.href} redirected to a place that is not allowed. ${problem}`)
      at = next
      continue
    }
    if (!res.ok) throw new ImportRefused(`Could not download ${at.href}: HTTP ${res.status}`)
    const declared = Number(res.headers.get('content-length') ?? NaN)
    if (declared > limits.archiveBytes) throw new ImportRefused(`The download is ${declared} bytes; at most ${limits.archiveBytes} are accepted`)
    const chunks: Buffer[] = []
    let got = 0
    const reader = res.body?.getReader()
    if (!reader) throw new ImportRefused(`${at.href} sent no body`)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.byteLength
      if (got > limits.archiveBytes) {
        await reader.cancel().catch(() => {})
        throw new ImportRefused(`The download is larger than ${limits.archiveBytes} bytes; stopped`)
      }
      chunks.push(Buffer.from(value))
    }
    const buf = Buffer.concat(chunks)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'download.zip'), buf, { mode: 0o600 })
    return buf
  }
}

export type StagedFiles = {
  files: { path: string; bytes: number }[]
  totalBytes: number
  skipped: { path: string; why: string }[]
}

/**
 * 이 기계의 출처(폴더나 .zip)를 `dest`(없는 폴더)로 옮겨 담는다. 뿌리는 **실제 경로**로 푼다 — 사람이 링크로 된 경로를 골랐으면
 * 그 링크는 사람이 고른 것이고(`/tmp`는 macOS에서 `/private/tmp`다), 그 **안의** 링크는 따라가지 않는다.
 */
export function stageLocal(path: string, dest: string, limits: ImportLimits): StagedFiles {
  let root: string
  try {
    root = realpathSync(path)
  } catch {
    throw new ImportRefused(`Nothing to import at ${path}`)
  }
  const st = statSync(root)
  if (st.isDirectory()) return copyFolder(root, dest, limits)
  if (!st.isFile()) throw new ImportRefused(`${path} is not a folder or a .zip file`)
  if (st.size > limits.archiveBytes) throw new ImportRefused(`${path} is ${st.size} bytes; at most ${limits.archiveBytes} are accepted`)
  const buf = readFileSync(root)
  if (!isZip(buf)) throw new ImportRefused(`${path} is not a folder or a .zip file`)
  return stageZip(buf, dest, limits)
}

/** 첫 네 바이트가 zip의 지역 머리(또는 빈 zip의 끝 머리)인가 */
export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && ((buf[2] === 3 && buf[3] === 4) || (buf[2] === 5 && buf[3] === 6))
}

/** 옮기지 않는 이름 — 한 칸이라도 이렇게 생겼으면 그 아래 전부를 건너뛴다(머리말의 "점으로 시작하는 이름") */
function hiddenPart(part: string): boolean {
  return part.startsWith('.') || part === '__MACOSX'
}

class Tally {
  out: StagedFiles = { files: [], totalBytes: 0, skipped: [] }
  constructor(private limits: ImportLimits) {}
  file(path: string, bytes: number): void {
    if (path.length > this.limits.pathChars) throw new ImportRefused(`A path is longer than ${this.limits.pathChars} characters: ${path.slice(0, 80)}…`)
    if (bytes > this.limits.fileBytes) throw new ImportRefused(`${path} is ${bytes} bytes; one file can be at most ${this.limits.fileBytes}`)
    if (this.out.files.length + 1 > this.limits.files) throw new ImportRefused(`More than ${this.limits.files} files; an app this large is not imported`)
    if (this.out.totalBytes + bytes > this.limits.totalBytes) throw new ImportRefused(`More than ${this.limits.totalBytes} bytes in all; an app this large is not imported`)
    this.out.files.push({ path, bytes })
    this.out.totalBytes += bytes
  }
  skip(path: string, why: string): void {
    this.out.skipped.push({ path, why })
  }
  depth(path: string, depth: number): void {
    if (depth > this.limits.depth) throw new ImportRefused(`Folders nest deeper than ${this.limits.depth} levels: ${path}`)
  }
}

/**
 * 폴더를 옮긴다. `lstat`으로 보고 링크는 따라가지 않는다. 파일은 여는 순간에도 링크가 아닌지(`O_NOFOLLOW`), 그리고 뿌리 안인지
 * (경로 가드 — 부모가 그사이 링크로 바뀌지 않았는지) 본 뒤, 연 기술자로 읽는다. 같은 사용자가 그사이에 바꿔치는 경주는 남는다
 * (docs/security-boundaries.md "Project files"의 한계와 같다).
 */
function copyFolder(root: string, dest: string, limits: ImportLimits): StagedFiles {
  const t = new Tally(limits)
  mkdirSync(dest)
  const walk = (rel: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })
    } catch (e) {
      throw new ImportRefused(`Could not read ${rel || root}: ${(e as Error).message}`)
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (hiddenPart(e.name)) {
        t.skip(e.isDirectory() ? `${r}/` : r, 'hidden')
        continue
      }
      const full = join(root, r)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        let target: string
        try {
          target = realpathSync(full)
        } catch {
          t.skip(r, 'link to nothing')
          continue
        }
        if (!inside(root, target)) throw new ImportRefused(`${r} is a link to ${target}, outside the folder. Links are not followed; remove it and import again`)
        t.skip(r, 'link')
        continue
      }
      if (st.isDirectory()) {
        t.depth(r, depth + 1)
        mkdirSync(join(dest, r))
        walk(r, depth + 1)
        continue
      }
      if (!st.isFile()) {
        t.skip(r, 'not a regular file')
        continue
      }
      t.file(r, st.size)
      writeFileSync(join(dest, r), readRegular(root, r, st.size), { mode: execBits(st.mode) })
    }
  }
  walk('', 0)
  return t.out
}

/** 뿌리 안의 보통 파일 하나를 읽는다 — 경로 가드로 부모를 보고, 마지막 칸은 링크를 따라가지 않고 연다 */
function readRegular(root: string, rel: string, size: number): Buffer {
  if (!assertExistingPathSync(root, rel).isFile()) throw new ImportRefused(`${rel} changed while it was being read`)
  const fd = openSync(join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size !== size) throw new ImportRefused(`${rel} changed while it was being read`)
    const buf = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off)
      if (n === 0) break
      off += n
    }
    return buf.subarray(0, off)
  } finally {
    closeSync(fd)
  }
}

/** 실행 비트만 넘긴다 — 셋uid 같은 것은 옮기지 않는다 */
function execBits(mode: number): number {
  return mode & 0o111 ? 0o755 : 0o644
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * zip을 푼다. 먼저 모든 항목의 이름과 종류와 선언한 크기를 판정하고(하나라도 틀리면 아무것도 쓰지 않는다), 그다음에 쓴다.
 * 묶음이 폴더 하나를 통째로 담았으면(흔한 모양: `notes/centralu.app.json`) 그 폴더를 뿌리로 본다.
 */
export function stageZip(buf: Buffer, dest: string, limits: ImportLimits): StagedFiles {
  let entries: ZipEntry[]
  try {
    entries = readZipEntries(buf, limits.files * 2)
  } catch (e) {
    throw new ImportRefused((e as Error).message)
  }
  const named = entries.map((e) => ({ e, parts: zipParts(e.name, limits) })).filter((x) => x.parts.length > 0)
  /*
   * 뿌리 폴더를 벗길지는 **옮길 항목만으로** 정한다. macOS의 압축은 `__MACOSX/`를 곁에 넣어 맨 위 칸이 둘이 되는데, 그것은 옮기지
   * 않는 것이라 셈에 넣으면 폴더 하나를 담은 흔한 묶음이 "매니페스트가 없다"로 거절된다.
   */
  const visible = named.filter((x) => !hiddenPart(x.parts[0]!))
  const top = new Set(visible.map((x) => x.parts[0]!))
  const strip =
    !visible.some((x) => x.parts.length === 1 && x.parts[0] === MANIFEST_FILE) &&
    top.size === 1 &&
    visible.every((x) => x.parts.length > 1 || x.e.kind === 'dir')
  const t = new Tally(limits)
  const plan: { parts: string[]; e: ZipEntry }[] = []
  const seen = new Map<string, 'file' | 'dir'>()
  for (const { e, parts: all } of named) {
    // 맨 위 칸부터 옮기지 않는 이름이면(`__MACOSX/`) 벗기기 전에 건너뛴다 — 벗기면 그 아래가 앱의 파일처럼 보인다
    if (hiddenPart(all[0]!)) {
      const at = all.length > 1 || e.kind === 'dir' ? `${all[0]}/` : all[0]!
      if (!t.out.skipped.some((s) => s.path === at)) t.skip(at, 'hidden')
      continue
    }
    const parts = strip ? all.slice(1) : all
    if (parts.length === 0) continue
    const path = wireJoin(...parts)
    const hidden = parts.findIndex(hiddenPart)
    if (hidden >= 0) {
      const at = wireJoin(...parts.slice(0, hidden + 1))
      if (!t.out.skipped.some((s) => s.path === at || s.path === `${at}/`)) t.skip(hidden < parts.length - 1 || e.kind === 'dir' ? `${at}/` : at, 'hidden')
      continue
    }
    if (e.kind === 'link') {
      // 링크의 내용(가리키는 경로)은 선언한 크기만큼만 읽는다 — 밖을 가리키면 거절, 안을 가리키면 옮기지 않는다
      const target = e.size <= 4096 ? readZipEntry(buf, e).toString('utf8') : '(too long)'
      const resolved = [...parts.slice(0, -1)]
      let escapes = target.startsWith('/') || target.includes('\\') || /^[a-z]:/i.test(target)
      for (const p of wireSegments(target)) {
        if (escapes) break
        if (p === '' || p === '.') continue
        if (p === '..') {
          if (resolved.length === 0) escapes = true
          else resolved.pop()
        } else resolved.push(p)
      }
      if (escapes) throw new ImportRefused(`${path} is a link to ${target}, outside the archive. Links are not followed`)
      t.skip(path, 'link')
      continue
    }
    if (e.kind === 'other') {
      t.skip(path, 'not a regular file')
      continue
    }
    t.depth(path, parts.length)
    // 대소문자와 유니코드 정규형만 다른 두 이름은 macOS의 파일 시스템에서 한 파일이다 — 사람이 본 목록과 쓰인 파일이 달라진다
    const key = parts.map((p) => p.normalize('NFC').toLowerCase())
    for (let i = 1; i < key.length; i++) {
      const dir = wireJoin(...key.slice(0, i))
      if (seen.get(dir) === 'file') throw new ImportRefused(`The archive has both a file and a folder named ${wireJoin(...parts.slice(0, i))}`)
      seen.set(dir, 'dir')
    }
    const k = wireJoin(...key)
    const kind = e.kind === 'dir' ? 'dir' : 'file'
    const had = seen.get(k)
    if (had && (had === 'file' || kind === 'file')) throw new ImportRefused(`The archive has two entries for ${path}`)
    seen.set(k, kind)
    if (kind === 'file') t.file(path, e.size)
    plan.push({ parts, e })
  }

  mkdirSync(dest)
  for (const { parts, e } of plan) {
    const out = join(dest, ...parts)
    if (!inside(dest, out)) throw new ImportRefused(`${wireJoin(...parts)} would be written outside the app folder`)
    if (e.kind === 'dir') {
      mkdirSync(out, { recursive: true })
      continue
    }
    mkdirSync(join(dest, ...parts.slice(0, -1)), { recursive: true })
    let data: Buffer
    try {
      data = readZipEntry(buf, e)
    } catch (err) {
      throw new ImportRefused(err instanceof ZipError ? err.message : `Could not unpack ${wireJoin(...parts)}: ${(err as Error).message}`)
    }
    writeFileSync(out, data, { mode: 0o644 })
  }
  t.out.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return t.out
}

/**
 * zip 항목 이름 → 경로의 칸들. 밖으로 새는 모양은 모두 거절한다(zip slip): 절대 경로, 드라이브 문자, 역슬래시, `..`, `.`,
 * 빈 칸(`a//b`), 제어 문자. 디렉터리 항목의 끝 `/`만 받는다.
 */
function zipParts(name: string, limits: ImportLimits): string[] {
  if (name.length > limits.pathChars) throw new ImportRefused(`An entry name is longer than ${limits.pathChars} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ImportRefused(`An entry name contains a control character: ${JSON.stringify(name)}`)
  if (name.includes('\\')) throw new ImportRefused(`An entry name uses a backslash: ${name}`)
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) throw new ImportRefused(`An entry has an absolute path: ${name}`)
  const parts = name.endsWith('/') ? wireSegments(name.slice(0, -1)) : wireSegments(name)
  if (name === '/' || name === '') return []
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new ImportRefused(`An entry's path leaves the archive or is malformed: ${name}`)
  }
  return parts
}

/**
 * 옮겨 담은 폴더의 매니페스트를 읽고 판정한다 — 발견과 같은 한 벌(`parseManifest`)에, 새로 드는 앱의 이름 규칙을 더한다:
 * #93의 글자 규칙과 `app-` 머리 금지(`proposedMcpServerNameError`, 새 앱과 같다), 내장 앱의 id 금지.
 */
export function readStagedManifest(dir: string, reservedIds: readonly string[]): { manifest: AppManifest; warnings: string[] } {
  const path = join(dir, MANIFEST_FILE)
  let size: number
  try {
    const st = lstatSync(path)
    if (!st.isFile()) throw new Error('not a file')
    size = st.size
  } catch {
    throw new ImportRefused(`There is no ${MANIFEST_FILE} at the top, so this is not a Centralu app`)
  }
  if (size > MAX_MANIFEST_BYTES) throw new ImportRefused(`${MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes`)
  const parsed = parseManifest(readFileSync(path, 'utf8'))
  if (!parsed.ok) throw new ImportRefused(`${MANIFEST_FILE} is not valid: ${parsed.error}`)
  const id = parsed.manifest.id
  const idProblem = proposedMcpServerNameError(id)
  if (idProblem) throw new ImportRefused(`The app id "${id}" cannot be used: ${idProblem}`)
  if (reservedIds.includes(id)) throw new ImportRefused(`"${id}" is the name of a built-in app; this app cannot be imported under it`)
  return { manifest: parsed.manifest, warnings: parsed.warnings }
}

/**
 * 사람이 켜기 전에 볼 것 (E-3) — 무엇을 돌리는지(명령과 인자), 무엇을 쓰겠다는지(uses), 어떤 비밀을 원하는지, 어떤 파일이
 * 들어오는지. `reviewKey`는 이 중 켜기가 묶이는 것(server와 uses)의 열쇠다.
 */
export function reviewOf(
  manifest: AppManifest,
  staged: StagedFiles,
  meta: { source: string; warnings: string[]; changed?: AppReview['changed'] },
): AppReview {
  return {
    appId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    server: { command: manifest.server.command, args: manifest.server.args },
    uses: {
      ...(manifest.uses.agent !== undefined ? { agent: manifest.uses.agent } : {}),
      ...(manifest.uses.apps ? { apps: manifest.uses.apps } : {}),
      ...(manifest.uses.host ? { host: manifest.uses.host } : {}),
    },
    secrets: manifest.secrets ?? [],
    home: manifest.home ?? null,
    viewOrigin: manifest.view?.origin ?? 'opaque',
    files: staged.files,
    totalBytes: staged.totalBytes,
    skipped: staged.skipped,
    warnings: meta.warnings,
    reviewKey: reviewKey(manifest),
    source: meta.source,
    changed: meta.changed ?? null,
  }
}

/**
 * 이미 들어온 앱 폴더의 파일 목록 — 다시 묻는 창이 보일 것. 옮겨 담을 때와 같은 규칙으로 걷되(링크는 따라가지 않고 점 이름은
 * 적기만 한다) 아무것도 쓰지 않는다. 상한을 넘으면 거기서 멈추고 그렇다고 적는다 — 목록을 보이는 것이 앱을 막을 까닭은 아니다.
 */
export function listAppFiles(dir: string, limits: ImportLimits): StagedFiles {
  const out: StagedFiles = { files: [], totalBytes: 0, skipped: [] }
  const walk = (rel: string, depth: number): boolean => {
    let entries: Dirent[]
    try {
      entries = readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true })
    } catch {
      return true
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (hiddenPart(e.name)) {
        out.skipped.push({ path: e.isDirectory() ? `${r}/` : r, why: 'hidden' })
        continue
      }
      if (e.isSymbolicLink()) {
        out.skipped.push({ path: r, why: 'link' })
        continue
      }
      if (e.isDirectory()) {
        if (depth + 1 > limits.depth || !walk(r, depth + 1)) return false
        continue
      }
      if (!e.isFile()) continue
      if (out.files.length >= limits.files) {
        out.skipped.push({ path: `${rel || '.'}/…`, why: `more than ${limits.files} files; the rest are not listed` })
        return false
      }
      let bytes = 0
      try {
        bytes = lstatSync(join(dir, r)).size
      } catch {
        // 읽는 사이에 사라졌다
      }
      out.files.push({ path: r, bytes })
      out.totalBytes += bytes
    }
    return true
  }
  walk('', 0)
  return out
}

/** 대기실 하나를 치운다 — 실패해도 조용히(다음 기동이 대기실 전체를 치운다) */
export function discard(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
