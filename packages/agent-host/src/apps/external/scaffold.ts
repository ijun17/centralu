import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertExistingPathSync, isMissingPathError } from '../../dev-services/path-guard.js'
import { MANIFEST_FILE, parseManifest, type AppManifest } from './manifest.js'

/**
 * 새 앱의 틀 (M4 C-1) — 템플릿 폴더를 앱 폴더로 펼친다.
 *
 * 템플릿(`packages/agent-host/app-template/`)은 제품의 자산이다: 만드는 에이전트가 처음 보는 코드가
 * 이것이고, 규칙(도구 주석·공개 범위·상태는 서버에·데이터 폴더·갱신 알림)을 **처음부터 지키는** 앱이어야
 * 에이전트가 그 모양을 따라 고친다(S-6: 에이전트는 런타임을 건드리지 않고 서버와 화면만 고쳤다).
 * 런타임(`runtime/`)은 스크립트가 만든 생성물이라 바이트 그대로 복사한다(`build-app-runtime.mjs`).
 *
 * 이 파일은 **펼치기만 한다** — 어디에 펼칠지(신뢰·이름·이미 있는 id)는 런타임의 문(`createApp`)이 정한다.
 */

/** 앱 이름·id가 들어가는 자리 */
const ID = '{{APP_ID}}'
const NAME = '{{APP_NAME}}'
const DESCRIPTION = '{{APP_DESCRIPTION}}'

/** 생성물 — 바이트 그대로 복사하고 자리 채우기를 하지 않는다 */
const VERBATIM_DIR = 'runtime'

/**
 * 점으로 시작하는 파일은 템플릿에 **점 없이** 둔다. 배포 묶음이 자원을 글롭(`resources/host/**`)으로 모으는데, 점 파일을
 * 줍는지는 묶는 도구마다 다르다 — 빠지면 앱마다 생성물 표시가 조용히 사라진다.
 */
const RENAMED: Record<string, string> = { gitattributes: '.gitattributes' }

/** 이 파일이 있어야 템플릿이다 — 런타임이 빠진 템플릿은 `node server.mjs`가 뜨지 않는 앱을 만든다 */
const REQUIRED = [MANIFEST_FILE, 'server.mjs', join(VERBATIM_DIR, 'centralu-app-runtime.mjs'), join(VERBATIM_DIR, 'mcp-app.js')]

/**
 * 템플릿이 있는 곳. 스키마·다리 스크립트와 같은 문제다(`bridge-path.ts`): 소스로 돌면 패키지 안에서,
 * 번들된 배포 앱은 산출물 옆에서 찾는다(`scripts/bundle.mjs`가 복사한다).
 */
export function appTemplateDir(): string {
  const candidates = [
    new URL('../../../app-template/', import.meta.url), // 소스 트리 (src/apps/external → packages/agent-host)
    new URL('./app-template/', import.meta.url), // 번들 산출물 레이아웃 (resources/host/main.mjs 옆)
  ].map((u) => fileURLToPath(u))
  const found = candidates.find((d) => REQUIRED.every((f) => existsSync(join(d, f))))
  if (!found) throw new Error(`app template not found (or its runtime is missing): ${candidates.join(', ')}`)
  return found
}

export type ScaffoldSpec = { id: string; name: string; description: string }

/**
 * 템플릿을 `dest`(아직 없는 폴더)에 펼치고 매니페스트를 돌려준다.
 *
 * 매니페스트는 글자를 갈아 끼우지 않고 **읽어서 고친 뒤 판정에 통과시켜** 쓴다(`parseManifest` —
 * 발견이 읽는 것과 같은 한 벌). 이름에 따옴표가 있어도 JSON이 깨지지 않고, 통과하지 못하는 앱은
 * 폴더가 생기기 전에 멈춘다.
 */
export function scaffoldApp(templateDir: string, dest: string, spec: ScaffoldSpec): AppManifest {
  const raw = JSON.parse(readFileSync(join(templateDir, MANIFEST_FILE), 'utf8')) as Record<string, unknown>
  const text = JSON.stringify({ ...raw, id: spec.id, name: spec.name, description: spec.description }, null, 2) + '\n'
  const parsed = parseManifest(text)
  if (!parsed.ok) throw new Error(`the template's manifest does not pass with these values: ${parsed.error}`)

  mkdirSync(dest)
  copyTree(templateDir, dest, '', spec)
  writeFileSync(join(dest, MANIFEST_FILE), text)
  return parsed.manifest
}

function copyTree(from: string, to: string, rel: string, spec: ScaffoldSpec): void {
  for (const e of readdirSync(join(from, rel), { withFileTypes: true })) {
    if (e.name === '.DS_Store') continue
    const src = join(rel, e.name)
    const out = join(rel, RENAMED[e.name] && rel === '' ? RENAMED[e.name]! : e.name)
    if (e.isDirectory()) {
      mkdirSync(join(to, out))
      copyTree(from, to, src, spec)
      continue
    }
    if (!e.isFile() || (rel === '' && e.name === MANIFEST_FILE)) continue
    const buf = readFileSync(join(from, src))
    const verbatim = src === VERBATIM_DIR || src.startsWith(VERBATIM_DIR + '/') || src.startsWith(VERBATIM_DIR + '\\')
    writeFileSync(join(to, out), verbatim ? buf : fill(buf.toString('utf8'), extname(e.name), spec))
  }
}

/**
 * 자리 채우기 — 들어가는 자리의 문법대로 거른다. id는 글자 규칙(#93)상 어디에 넣어도 안전하다.
 * 이름·설명은 사람이 쓴 글이라 HTML에서는 이스케이프하고, 그 밖(마크다운, 코드의 `//` 주석)에서는
 * 한 줄로만 넣는다(`normalizeName`이 이미 한 줄로 만든다).
 */
function fill(text: string, ext: string, spec: ScaffoldSpec): string {
  const esc = ext === '.html' ? escapeHtml : (s: string) => s
  return text.split(ID).join(spec.id).split(NAME).join(esc(spec.name)).split(DESCRIPTION).join(esc(spec.description))
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** 사람이 준 이름·설명을 한 줄로 — 줄바꿈이 코드 주석을 끊지 못하게 */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * `<root>/<parts…>`까지의 폴더를 **한 칸씩** 만든다 — 칸마다 뿌리 밖으로 새는 링크인지 먼저 본다.
 * `mkdir -p`로 한 번에 만들면, 프로젝트 안의 `.centralu`가 밖을 가리키는 링크일 때 앱이 저장소
 * 밖에 쓰인다(발견과 감시가 같은 가드로 거절하는 링크다 — 만드는 쪽도 같아야 한다).
 */
export function ensureDirInside(root: string, parts: readonly string[]): string {
  for (let i = 1; i <= parts.length; i++) {
    const prefix = join(...parts.slice(0, i))
    try {
      if (!assertExistingPathSync(root, prefix).isDirectory()) throw new Error(`${prefix} is not a folder`)
    } catch (err) {
      if (!isMissingPathError(err)) throw err
      mkdirSync(join(root, prefix))
      assertExistingPathSync(root, prefix)
    }
  }
  return join(root, ...parts)
}
