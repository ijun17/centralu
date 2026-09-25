import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { assertExistingPathSync, isMissingPathError } from '../../dev-services/path-guard.js'
import { MANIFEST_FILE, MAX_MANIFEST_BYTES, parseManifest, type AppManifest } from './manifest.js'

/**
 * 앱이 사는 자리를 훑는다 (M4 A-2, 플랜 결정 1).
 *
 *   프로젝트 앱   <등록된 프로젝트 뿌리>/.centralu/apps/<id>/centralu.app.json
 *   사용자 앱     <host 데이터 폴더>/apps/<id>/centralu.app.json
 *
 * 이 파일은 **읽기만 한다** — 폴더를 만들지도, 프로세스를 띄우지도 않는다. 무엇을 띄울지는
 * 런타임이 신뢰를 보고 정한다. 그래서 신뢰하지 않은 프로젝트의 앱도 여기서는 똑같이
 * 발견되고, 목록에 이유와 함께 선다.
 */

export const PROJECT_APPS_REL = '.centralu/apps'
export const USER_APPS_REL = 'apps'
/** 같은 자리를 경로의 칸으로 — 폴더를 만드는 쪽(`createApp`)이 한 칸씩 가드를 지나며 만든다 */
export const PROJECT_APPS_PARTS = ['.centralu', 'apps'] as const
export const USER_APPS_PARTS = ['apps'] as const

export type ScannedApp = {
  /** 폴더 이름. 매니페스트가 맞으면 id와 같다(아래 규칙) */
  folder: string
  /** 앱 프로세스의 cwd가 될 절대 경로 — 검사한 경로 그대로다 */
  dir: string
  /** 매니페스트 원문의 해시. 바뀌었는지를 이것으로 안다 (없거나 못 읽었으면 null) */
  hash: string | null
  manifest: AppManifest | null
  error: string | null
  warnings: string[]
}

export type ScanResult = {
  apps: ScannedApp[]
  /**
   * 감시할 디렉토리들(뿌리 기준 상대 경로). 앱 폴더가 아직 없으면 **있는 가장 깊은 조상**을
   * 본다 — `.centralu/apps`가 나중에 생기는 것도 알아채야 하기 때문이다.
   */
  watch: string[]
}

/**
 * @param root   프로젝트 뿌리 또는 host 데이터 폴더
 * @param rel    앱 폴더들의 부모 (PROJECT_APPS_REL | USER_APPS_REL)
 * @param ancestors  `rel`이 없을 때 대신 볼 조상들 (얕은 것부터). 사용자 쪽은 비운다 —
 *                   데이터 폴더 자체를 보면 store.db가 쓰일 때마다 깨어난다.
 */
export function scanApps(root: string, rel: string, ancestors: readonly string[]): ScanResult {
  let entries: Dirent[]
  try {
    assertExistingPathSync(root, rel)
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch (e) {
    if (!isMissingPathError(e) && !isFsMissing(e)) {
      // 뿌리 밖을 가리키는 링크 등 — 앱이 없는 것과 같게 다루되 감시도 하지 않는다
      return { apps: [], watch: [] }
    }
    const deepest = [...ancestors].reverse().find((a) => existsSync(join(root, a)))
    return { apps: [], watch: deepest === undefined ? [] : [deepest] }
  }

  const apps: ScannedApp[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const folderRel = `${rel}/${e.name}`
    const dir = join(root, rel, e.name)
    /*
     * 폴더 감시(DirWatchers)와 **같은 가드**로 묻는다. 뿌리 밖을 가리키는 링크를 여기서만
     * 받아 주면, 발견은 되는데 바뀌어도 다시 읽히지 않는 반쪽 앱이 생긴다 — 감시가
     * 그 링크를 거절하기 때문이다. 발견되는 것과 감시되는 것이 같아야 한다.
     */
    try {
      if (!assertExistingPathSync(root, folderRel).isDirectory()) continue
    } catch (err) {
      if (isMissingPathError(err)) continue // 읽는 사이에 사라졌다
      apps.push(invalid(e.name, dir, '앱 폴더가 뿌리 밖을 가리키는 링크입니다 — 링크를 따라가지 않습니다'))
      continue
    }
    apps.push(readApp(root, folderRel, e.name, dir))
  }
  apps.sort((a, b) => a.folder.localeCompare(b.folder))
  return { apps, watch: [rel, ...apps.flatMap((a) => [`${rel}/${a.folder}`, ...subfoldersOf(root, `${rel}/${a.folder}`)])] }
}

/** 앱 폴더 하나에서 감시할 하위 폴더의 상한 — 감시는 프로젝트당 256개(`MAX_WATCHED_DIRS`)를 나눠 쓴다 */
const SUBFOLDERS_WATCHED = 8

/**
 * 앱 폴더 바로 아래의 폴더들 (C-4) — `ui/`처럼 코드가 사는 자리. 감시는 재귀가 아니라서(`DirWatchers`), 이것을
 * 보지 않으면 편집기에서 `ui/index.html`을 고친 것을 모른다. 한 칸 아래까지만 본다: 더 깊은 변화는 만드는 세션의
 * 턴 끝이 지문으로 잡는다(`fingerprint.ts`). 점으로 시작하는 폴더와 `node_modules`는 앱의 코드가 아니다.
 */
function subfoldersOf(root: string, appRel: string): string[] {
  try {
    return readdirSync(join(root, appRel), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => `${appRel}/${d.name}`)
      .sort()
      .slice(0, SUBFOLDERS_WATCHED)
  } catch {
    return []
  }
}

function readApp(root: string, folderRel: string, folder: string, dir: string): ScannedApp {
  const manifestRel = `${folderRel}/${MANIFEST_FILE}`
  let text: string
  try {
    if (!assertExistingPathSync(root, manifestRel).isFile()) {
      return invalid(folder, dir, `${MANIFEST_FILE}가 파일이 아닙니다`)
    }
    text = readCapped(join(root, manifestRel))
  } catch (err) {
    if (isMissingPathError(err) || isFsMissing(err)) {
      // 만드는 중인 폴더일 수 있다 — 숨기지 않고 무엇이 빠졌는지 말한다
      return invalid(folder, dir, `${MANIFEST_FILE}가 없습니다`)
    }
    return invalid(folder, dir, `${MANIFEST_FILE}를 읽지 못했습니다: ${(err as Error).message}`)
  }
  const hash = createHash('sha256').update(text).digest('hex')
  const parsed = parseManifest(text)
  if (!parsed.ok) return { folder, dir, hash, manifest: null, error: parsed.error, warnings: parsed.warnings }
  /*
   * 폴더 이름이 곧 id다. 같은 자리에 id가 같은 앱 둘이 서는 것을 파일시스템이 막아 주고
   * (폴더 이름은 겹칠 수 없다), 사람이 폴더를 보고 어느 앱인지 안다.
   */
  if (parsed.manifest.id !== folder) {
    return {
      folder, dir, hash, manifest: null, warnings: parsed.warnings,
      error: `폴더 이름(${folder})과 매니페스트의 id(${parsed.manifest.id})가 다릅니다 — 폴더 이름이 곧 id입니다`,
    }
  }
  return { folder, dir, hash, manifest: parsed.manifest, error: null, warnings: parsed.warnings }
}

function invalid(folder: string, dir: string, error: string): ScannedApp {
  return { folder, dir, hash: null, manifest: null, error, warnings: [] }
}

/** 상한을 넘는 매니페스트는 끝까지 읽지 않는다 (MAX_MANIFEST_BYTES 주석) */
function readCapped(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size > MAX_MANIFEST_BYTES) {
      throw new Error(`${MAX_MANIFEST_BYTES}바이트를 넘습니다 (${size}바이트)`)
    }
    const buf = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off)
      if (n === 0) break
      off += n
    }
    return buf.subarray(0, off).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function isFsMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
