import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppReview, ExternalAppInfo } from '@cc/protocol'
import { MANIFEST_FILE, MANIFEST_VERSION } from './manifest.js'
import { ExternalApps, type AppRef } from './runtime.js'
import { STAGING_REL, type HandoverOptions } from './handover.js'
import { IMPORTS_FILE } from './import-book.js'
import { until } from './test-helpers.js'
import { makeZip } from './zip.test-helpers.js'

/**
 * 가져오기 (M4 E-3) — 진짜 폴더·진짜 zip·진짜 앱 프로세스(env-app.mjs). 내려받기만 가짜다: https 서버를 띄우지 않고, 넘김·크기·
 * 내용을 `fetch` 자리에서 시험한다(`HandoverOptions.fetch`).
 *
 * 약속: 가져온 앱은 꺼진 채 들어오고(확인 전에는 뜨지 않는다), 켤 때 본 `server`·`uses`가 바뀌면 다시 묻는다. 링크는 따라가지 않고,
 * 이름으로 밖에 쓰지 않으며(zip slip), 상한을 넘으면 들이지 않는다. 겹치는 id와 규칙에 맞지 않는 id는 받지 않는다.
 */

const APP = fileURLToPath(new URL('./test-fixtures/env-app.mjs', import.meta.url))

let root = ''
let dataRoot = ''
let src = ''
let rt: ExternalApps

const userRef = (appId: string): AppRef => ({ projectId: null, appId })
const info = (appId: string) => (rt.list() as ExternalAppInfo[]).find((a) => a.appId === appId && a.projectId === null)
const manifest = (id: string, over: Record<string, unknown> = {}) => ({
  manifestVersion: MANIFEST_VERSION,
  id,
  name: `App ${id}`,
  version: '1.0.0',
  description: `imported ${id}`,
  server: { command: process.execPath, args: [APP, '--env', 'API_KEY'] },
  ...over,
})

/** 가져올 폴더 하나를 심는다 — 매니페스트와 파일들 */
function plantSource(name: string, id: string, files: Record<string, string> = {}, over: Record<string, unknown> = {}): string {
  const dir = join(src, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest(id, over), null, 2))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

function make(handover: HandoverOptions = {}) {
  rt = new ExternalApps({
    projects: () => [],
    dataRoot,
    reservedIds: ['control'],
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
    handover,
  })
  rt.refresh()
  return rt
}

/** 가져와서 들인다 — 켤지는 고른다 */
async function importApp(source: string, enable = false): Promise<{ app: ExternalAppInfo; review: AppReview }> {
  const { token, review } = await rt.prepareImport(source)
  const app = rt.commitImport(token, { enable, reviewKey: review.reviewKey })
  return { app, review }
}

const refusal = (p: Promise<unknown>) => p.then(
  () => null,
  (e: Error) => e.message,
)
const stagingLeft = () => (existsSync(join(dataRoot, STAGING_REL)) ? readdirSync(join(dataRoot, STAGING_REL)) : [])
const userApps = () => (existsSync(join(dataRoot, 'apps')) ? readdirSync(join(dataRoot, 'apps')) : [])

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-import-')))
  dataRoot = join(root, 'data')
  src = join(root, 'src')
  mkdirSync(dataRoot)
  mkdirSync(src)
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('들이기 전에 사람이 볼 것', () => {
  it('폴더를 준비하면 무엇을 돌리는지·무엇을 쓰는지·원하는 비밀·파일 목록이 오고, 대기실은 발견되지 않는다', async () => {
    make()
    const dir = plantSource('notes-src', 'notes', { 'server.mjs': '// code', 'ui/index.html': '<p>hi</p>', '.claude/settings.json': '{"hooks":{}}', '.env': 'SECRET=1' }, {
      uses: { agent: true, apps: ['other'], host: ['sessions'] },
      secrets: ['API_KEY'],
      home: 'show',
    })
    const { token, review } = await rt.prepareImport(dir)
    expect(review).toMatchObject({
      appId: 'notes',
      server: { command: process.execPath, args: [APP, '--env', 'API_KEY'] },
      uses: { agent: true, apps: ['other'], host: ['sessions'] },
      secrets: ['API_KEY'],
      home: 'show',
      source: dir,
      changed: null,
    })
    expect(review.files.map((f) => f.path)).toEqual([MANIFEST_FILE, 'server.mjs', 'ui/index.html'])
    // 점으로 시작하는 이름은 옮기지 않고, 옮기지 않은 까닭을 적는다
    expect(review.skipped).toEqual([
      { path: '.claude/', why: 'hidden' },
      { path: '.env', why: 'hidden' },
    ])
    expect(review.reviewKey).toMatch(/^[0-9a-f]{64}$/)
    // 준비는 들이는 것이 아니다 — 목록에 없고, 사용자 폴더에도 없다
    expect(info('notes')).toBeUndefined()
    expect(userApps()).toEqual([])
    expect(stagingLeft()).toEqual([token])
    rt.cancelImport(token)
    expect(stagingLeft()).toEqual([])
  })

  it('zip은 폴더 하나를 통째로 담았으면 그 폴더를 뿌리로 보고, file: 주소로도 받는다', async () => {
    make()
    const zip = join(src, 'notes.zip')
    writeFileSync(
      zip,
      makeZip([
        { name: 'notes/', mode: 0o040755 },
        { name: `notes/${MANIFEST_FILE}`, data: JSON.stringify(manifest('notes')) },
        { name: 'notes/server.mjs', data: '// code', mode: 0o100755 },
        { name: 'notes/.git/config', data: '[core]' },
        { name: '__MACOSX/notes/._server.mjs', data: 'fork' },
      ]),
    )
    const { review } = await rt.prepareImport(pathToFileURL(zip).href)
    expect(review.files.map((f) => f.path)).toEqual([MANIFEST_FILE, 'server.mjs'])
    expect(review.skipped.map((s) => s.path).sort()).toEqual(['.git/', '__MACOSX/'])
  })
})

describe('가져온 앱은 꺼진 채 들어오고, 사람이 켜기 전에는 뜨지 않는다', () => {
  it('들인 앱은 unconfirmed로 서고 이유가 있으며, 부르면 거절되고 프로세스가 뜨지 않는다 — 켜면 뜬다', async () => {
    make()
    const log = join(root, 'env-app.log')
    const dir = plantSource('notes-src', 'notes', {}, { server: { command: process.execPath, args: [APP, '--env', 'API_KEY'] } })
    const { app, review } = await importApp(dir)
    expect(app).toMatchObject({ appId: 'notes', projectId: null, status: 'unconfirmed', imported: { source: dir, confirmedAt: null } })
    expect(app.error).toContain('not enabled yet')

    const refused = await rt.call(userRef('notes'), 'env', {}, { kind: 'view' })
    expect(refused.status).toBe('rejected')
    expect(refused.error).toContain('not enabled yet')
    await expect(rt.tools(userRef('notes'))).rejects.toThrow('not enabled yet')
    expect((await rt.check(userRef('notes'))).findings).toContainEqual(expect.objectContaining({ level: 'problem', message: expect.stringContaining('not enabled yet') }))
    // 확인 전에는 한 번도 뜨지 않았다 — 목록의 상태도, 앱이 남긴 흔적도
    expect(info('notes')?.status).toBe('unconfirmed')
    expect(existsSync(log)).toBe(false)
    expect(existsSync(join(dataRoot, 'app-logs', '_user', 'notes.log'))).toBe(false)

    const enabled = rt.enableApp(userRef('notes'), review.reviewKey)
    expect(enabled.status).toBe('stopped')
    expect(enabled.imported?.confirmedAt).toEqual(expect.any(Number))
    const ran = await rt.call(userRef('notes'), 'env', {}, { kind: 'view' })
    expect(ran.status).toBe('ok')
  })

  it('"들이며 켜기"는 사람이 본 열쇠일 때만 켠다 — 다른 열쇠면 아무것도 들이지 않는다', async () => {
    make()
    const dir = plantSource('notes-src', 'notes')
    const { token, review } = await rt.prepareImport(dir)
    expect(() => rt.commitImport(token, { enable: true, reviewKey: 'f'.repeat(64) })).toThrow('What would be enabled is not what you reviewed')
    expect(userApps()).toEqual([])
    const app = rt.commitImport(token, { enable: true, reviewKey: review.reviewKey })
    expect(app.status).toBe('stopped')
    expect((await rt.call(userRef('notes'), 'env', {}, { kind: 'view' })).status).toBe('ok')
  })

  it('표시는 host의 데이터 폴더에 있고, 그 폴더에 묶인다 — 지우고 같은 id로 새로 만든 앱에는 걸리지 않는다', async () => {
    make()
    await importApp(plantSource('notes-src', 'notes'))
    expect(JSON.parse(readFileSync(join(dataRoot, IMPORTS_FILE), 'utf8'))).toHaveProperty('notes')
    // 앱 폴더 안에는 표시가 없다 — 앱의 코드가 지우거나 고칠 수 없다
    expect(readdirSync(join(dataRoot, 'apps', 'notes'))).toEqual([MANIFEST_FILE])
    rt.removeUserApp(userRef('notes'))
    const again = join(dataRoot, 'apps', 'notes')
    mkdirSync(again, { recursive: true })
    writeFileSync(join(again, MANIFEST_FILE), JSON.stringify(manifest('notes')))
    rt.refresh()
    expect(info('notes')?.status).toBe('stopped')
    expect(info('notes')?.imported).toBeUndefined()
  })
})

describe('켠 뒤 server·uses가 바뀌면 다시 묻는다', () => {
  const edit = (id: string, over: Record<string, unknown>) => {
    const path = join(dataRoot, 'apps', id, MANIFEST_FILE)
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...over }, null, 2))
    rt.refresh()
  }

  it('명령이 바뀌면 호출이 막히고, 확인 창이 켠 때의 명령과 함께 무엇이 바뀌었는지 말한다 — 새 열쇠로 켜면 다시 돈다', async () => {
    make()
    await importApp(plantSource('notes-src', 'notes'), true)
    expect((await rt.call(userRef('notes'), 'env', {}, { kind: 'view' })).status).toBe('ok')

    edit('notes', { server: { command: process.execPath, args: [APP, '--env', 'OTHER'] } })
    await until(() => info('notes')?.status, (s) => s === 'unconfirmed')
    expect(info('notes')?.error).toContain('changed what it runs or what it uses')
    const refused = await rt.call(userRef('notes'), 'env', {}, { kind: 'view' })
    expect(refused).toMatchObject({ status: 'rejected' })

    const review = rt.reviewApp(userRef('notes'))
    expect(review.changed).toEqual({
      server: true,
      uses: false,
      was: { server: { command: process.execPath, args: [APP, '--env', 'API_KEY'] }, uses: {} },
    })
    expect(review.server.args).toEqual([APP, '--env', 'OTHER'])
    rt.enableApp(userRef('notes'), review.reviewKey)
    const ran = await rt.call(userRef('notes'), 'env', {}, { kind: 'view' })
    expect(ran.status).toBe('ok')
    expect(ran.result?.content[0]).toMatchObject({ text: expect.stringContaining('OTHER=') })
  })

  it('uses가 바뀌어도 다시 묻고, 그 밖의 칸(설명)은 묻지 않는다', async () => {
    make()
    await importApp(plantSource('notes-src', 'notes'), true)
    edit('notes', { description: 'a new description' })
    expect(info('notes')?.status).toBe('stopped')
    edit('notes', { uses: { agent: true } })
    expect(info('notes')?.status).toBe('unconfirmed')
    expect(rt.reviewApp(userRef('notes')).changed).toMatchObject({ server: false, uses: true, was: { uses: {} } })
  })

  it('확인 창을 본 뒤에 바뀌었으면 그 창의 열쇠로는 켜지지 않는다', async () => {
    make()
    await importApp(plantSource('notes-src', 'notes'))
    const seen = rt.reviewApp(userRef('notes'))
    edit('notes', { server: { command: '/bin/sh', args: ['-c', 'echo sneaky'] } })
    expect(() => rt.enableApp(userRef('notes'), seen.reviewKey)).toThrow('This app changed since you reviewed it')
    expect(info('notes')?.status).toBe('unconfirmed')
  })

  it('가져오지 않은 사용자 폴더 앱은 켤 것이 없고, 프로젝트 앱은 프로젝트 신뢰를 따른다', async () => {
    make()
    const dir = join(dataRoot, 'apps', 'mine')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest('mine')))
    rt.refresh()
    expect(info('mine')?.status).toBe('stopped')
    expect(() => rt.enableApp(userRef('mine'), 'x')).toThrow('This app was not imported, so it needs no enabling')
    expect(() => rt.reviewApp({ projectId: 'p1', appId: 'mine' })).toThrow("A project's apps follow the project's trust")
  })
})

describe('들이지 않는 것', () => {
  it('사용자 폴더에 같은 id가 있으면 준비에서, 그 사이 생겼으면 들일 때 거절하고 원래 앱은 그대로다', async () => {
    make()
    const mine = join(dataRoot, 'apps', 'notes')
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, MANIFEST_FILE), JSON.stringify(manifest('notes', { name: 'Mine' })))
    rt.refresh()
    expect(await refusal(rt.prepareImport(plantSource('notes-src', 'notes')))).toBe(
      'An app with the id "notes" is already in your apps. Remove it first, or change the id in its manifest',
    )
    expect(info('notes')?.name).toBe('Mine')
    expect(stagingLeft()).toEqual([])

    const { token } = await rt.prepareImport(plantSource('later-src', 'later'))
    const late = join(dataRoot, 'apps', 'later')
    mkdirSync(late)
    writeFileSync(join(late, MANIFEST_FILE), JSON.stringify(manifest('later', { name: 'Made meanwhile' })))
    expect(() => rt.commitImport(token, { enable: false })).toThrow('An app with the id "later" is already in your apps')
    expect(JSON.parse(readFileSync(join(late, MANIFEST_FILE), 'utf8')).name).toBe('Made meanwhile')
  })

  it('id는 새 앱과 같은 규칙이다 — app- 머리, centralu 머리, 내장 앱의 id, 밑줄', async () => {
    make()
    expect(await refusal(rt.prepareImport(plantSource('a', 'app-notes')))).toEqual(expect.stringMatching(/^The app id "app-notes" cannot be used: /))
    expect(await refusal(rt.prepareImport(plantSource('b', 'centralu-x')))).toEqual(expect.stringMatching(/^centralu\.app\.json is not valid: id: /))
    expect(await refusal(rt.prepareImport(plantSource('c', 'control')))).toBe('"control" is the name of a built-in app; this app cannot be imported under it')
    expect(await refusal(rt.prepareImport(plantSource('d', 'bad_id')))).toEqual(expect.stringMatching(/^centralu\.app\.json is not valid: id: /))
    expect(await refusal(rt.prepareImport(join(src, 'nothing-here')))).toBe(`Nothing to import at ${join(src, 'nothing-here')}`)
    const noManifest = join(src, 'plain')
    mkdirSync(noManifest)
    writeFileSync(join(noManifest, 'server.mjs'), '')
    expect(await refusal(rt.prepareImport(noManifest))).toBe('There is no centralu.app.json at the top, so this is not a Centralu app')
    expect(userApps()).toEqual([])
    expect(stagingLeft()).toEqual([])
  })

  it('폴더 안의 링크가 밖을 가리키면 거절하고(무엇을 가리키는지 말한다), 안을 가리키는 링크는 옮기지 않는다', async () => {
    make()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE KEY')
    const dir = plantSource('linky', 'linky', { 'lib/real.mjs': '// real' })
    symlinkSync(join(outside, 'id_rsa'), join(dir, 'lib', 'key'))
    expect(await refusal(rt.prepareImport(dir))).toBe(
      `lib/key is a link to ${join(outside, 'id_rsa')}, outside the folder. Links are not followed; remove it and import again`,
    )
    rmSync(join(dir, 'lib', 'key'))
    symlinkSync(outside, join(dir, 'escape-dir'))
    expect(await refusal(rt.prepareImport(dir))).toContain('escape-dir is a link to')
    rmSync(join(dir, 'escape-dir'))
    symlinkSync('real.mjs', join(dir, 'lib', 'alias.mjs'))
    const { review } = await rt.prepareImport(dir)
    expect(review.files.map((f) => f.path)).toEqual([MANIFEST_FILE, 'lib/real.mjs'])
    expect(review.skipped).toEqual([{ path: 'lib/alias.mjs', why: 'link' }])
    // 밖의 파일은 어디에도 옮겨지지 않았다
    expect(JSON.stringify(readdirSync(join(dataRoot), { recursive: true }))).not.toContain('id_rsa')
  })

  it('상한: 파일 수, 파일 하나, 합계, 깊이, 묶음 크기', async () => {
    make({ limits: { files: 3, fileBytes: 1_000, totalBytes: 1_500, depth: 3, archiveBytes: 2_000 } })
    expect(await refusal(rt.prepareImport(plantSource('many', 'many', { a: '', b: '', c: '' })))).toBe('More than 3 files; an app this large is not imported')
    expect(await refusal(rt.prepareImport(plantSource('big', 'big', { 'big.bin': 'x'.repeat(1_001) })))).toBe('big.bin is 1001 bytes; one file can be at most 1000')
    expect(await refusal(rt.prepareImport(plantSource('sum', 'sum', { 'a.bin': 'x'.repeat(990), 'b.bin': 'x'.repeat(300) })))).toEqual(expect.stringMatching(/^More than 1500 bytes in all/))
    expect(await refusal(rt.prepareImport(plantSource('deep', 'deep', { 'a/b/c/d/e.txt': '' })))).toBe('Folders nest deeper than 3 levels: a/b/c/d')
    const zip = join(src, 'huge.zip')
    writeFileSync(zip, makeZip([{ name: 'pad.bin', data: Buffer.alloc(3_000, 1), method: 0 }]))
    expect(await refusal(rt.prepareImport(zip))).toBe(`${zip} is ${readFileSync(zip).length} bytes; at most 2000 are accepted`)
    expect(userApps()).toEqual([])
    expect(stagingLeft()).toEqual([])
  })
})

describe('zip이 밖에 쓰지 못한다 (zip slip)', () => {
  const zipOf = (entries: Parameters<typeof makeZip>[0]) => {
    const zip = join(src, `z-${Math.random().toString(36).slice(2)}.zip`)
    writeFileSync(zip, makeZip([{ name: MANIFEST_FILE, data: JSON.stringify(manifest('zippy')) }, ...entries]))
    return zip
  }

  it('..·절대 경로·역슬래시·드라이브 문자·빈 칸은 이름을 보고 거절하고, 아무것도 쓰지 않는다', async () => {
    make()
    for (const [name, why] of [
      ['../evil.txt', "An entry's path leaves the archive or is malformed: ../evil.txt"],
      ['a/../../evil.txt', "An entry's path leaves the archive or is malformed: a/../../evil.txt"],
      // 대기실(<데이터>/app-staging/<토큰>/app)에서 세 칸 위는 데이터 폴더다
      ['../../../evil.txt', "An entry's path leaves the archive or is malformed: ../../../evil.txt"],
      ['/tmp/evil.txt', 'An entry has an absolute path: /tmp/evil.txt'],
      ['..\\evil.txt', 'An entry name uses a backslash: ..\\evil.txt'],
      ['C:/evil.txt', 'An entry has an absolute path: C:/evil.txt'],
      ['a//evil.txt', "An entry's path leaves the archive or is malformed: a//evil.txt"],
    ] as const) {
      expect(await refusal(rt.prepareImport(zipOf([{ name, data: 'pwned' }]))), name).toBe(why)
    }
    expect(existsSync(join(root, 'evil.txt'))).toBe(false)
    expect(existsSync(join(dataRoot, 'evil.txt'))).toBe(false)
    expect(existsSync(join(dataRoot, STAGING_REL, 'evil.txt'))).toBe(false)
    expect(stagingLeft()).toEqual([])
  })

  it('링크 항목은 밖을 가리키면 거절하고, 안을 가리키면 옮기지 않는다 — 링크를 만들지 않는다', async () => {
    make()
    expect(await refusal(rt.prepareImport(zipOf([{ name: 'up', data: '../../..', mode: 0o120777 }])))).toBe('up is a link to ../../.., outside the archive. Links are not followed')
    expect(await refusal(rt.prepareImport(zipOf([{ name: 'abs', data: '/etc', mode: 0o120777 }])))).toBe('abs is a link to /etc, outside the archive. Links are not followed')
    const { review, token } = await rt.prepareImport(zipOf([{ name: 'lib/real.mjs', data: '//' }, { name: 'lib/alias', data: 'real.mjs', mode: 0o120777 }]))
    expect(review.skipped).toEqual([{ path: 'lib/alias', why: 'link' }])
    rt.commitImport(token, { enable: false })
    expect(readdirSync(join(dataRoot, 'apps', 'zippy', 'lib'))).toEqual(['real.mjs'])
  })

  it('선언보다 크게 풀리는 항목(zip 폭탄)과 같은 이름 둘, 파일과 폴더가 겹치는 이름은 거절한다', async () => {
    make()
    expect(await refusal(rt.prepareImport(zipOf([{ name: 'bomb.bin', data: Buffer.alloc(100_000), declaredSize: 10 }])))).toEqual(expect.stringMatching(/^Could not unpack bomb\.bin: /))
    expect(await refusal(rt.prepareImport(zipOf([{ name: 'a.txt', data: '1' }, { name: 'A.txt', data: '2' }])))).toBe('The archive has two entries for A.txt')
    expect(await refusal(rt.prepareImport(zipOf([{ name: 'x', data: '1' }, { name: 'x/y', data: '2' }])))).toBe('The archive has both a file and a folder named x')
    expect(stagingLeft()).toEqual([])
  })
})

describe('https로 받는 zip', () => {
  const ZIP = makeZip([{ name: MANIFEST_FILE, data: JSON.stringify(manifest('remote')) }])
  const respond = (body: Buffer | string, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : new Uint8Array(body), init)

  it('이 기계·링크 로컬·http·다른 스킴·계정이 든 주소는 내려받지도 않는다', async () => {
    const asked: string[] = []
    make({ fetch: (async (u: URL) => (asked.push(String(u)), respond(ZIP))) as unknown as typeof fetch })
    for (const [source, why] of [
      ['https://localhost/a.zip', 'A link to this machine cannot be downloaded: https://localhost/a.zip'],
      ['https://127.0.0.1:8443/a.zip', 'A link to this machine or a link-local address cannot be downloaded: https://127.0.0.1:8443/a.zip'],
      ['https://169.254.169.254/latest', 'A link to this machine or a link-local address cannot be downloaded: https://169.254.169.254/latest'],
      ['https://[::1]/a.zip', 'A link to this machine or a link-local address cannot be downloaded: https://[::1]/a.zip'],
      ['https://user:pw@example.com/a.zip', 'Links with a user name or password in them are not accepted'],
      ['http://example.com/a.zip', 'Only folders and .zip files on this machine, or https links, can be imported: http://example.com/a.zip'],
      ['ftp://example.com/a.zip', 'Only folders and .zip files on this machine, or https links, can be imported: ftp://example.com/a.zip'],
      ['relative/app', 'Use the full path of the folder or .zip file: relative/app'],
    ] as const) {
      expect(await refusal(rt.prepareImport(source)), source).toBe(why)
    }
    expect(asked).toEqual([])
  })

  it('넘김은 https로만 따라가고, 선언한 크기나 받은 크기가 상한을 넘으면 멈추며, zip이 아니면 들이지 않는다', async () => {
    const routes: Record<string, () => Response> = {
      'https://example.com/redirect-to-http': () => respond('', { status: 302, headers: { location: 'http://example.com/a.zip' } }),
      'https://example.com/redirect-home': () => respond('', { status: 301, headers: { location: 'https://127.0.0.1/a.zip' } }),
      'https://example.com/declared-huge': () => respond(ZIP, { headers: { 'content-length': '999999999' } }),
      'https://example.com/streamed-huge': () => respond(Buffer.alloc(5_000)),
      'https://example.com/page.html': () => respond('<html>not a zip</html>'),
      'https://example.com/moved': () => respond('', { status: 302, headers: { location: '/app.zip' } }),
      'https://example.com/app.zip': () => respond(ZIP),
    }
    const asked: string[] = []
    make({
      limits: { archiveBytes: 4_000 },
      fetch: (async (u: URL) => {
        asked.push(String(u))
        return routes[String(u)]?.() ?? respond('', { status: 404 })
      }) as unknown as typeof fetch,
    })
    expect(await refusal(rt.prepareImport('https://example.com/redirect-to-http'))).toBe(
      'https://example.com/redirect-to-http redirected to a place that is not allowed. Only https links can be downloaded: http://example.com/a.zip',
    )
    expect(await refusal(rt.prepareImport('https://example.com/redirect-home'))).toContain('redirected to a place that is not allowed')
    expect(await refusal(rt.prepareImport('https://example.com/declared-huge'))).toBe('The download is 999999999 bytes; at most 4000 are accepted')
    expect(await refusal(rt.prepareImport('https://example.com/streamed-huge'))).toBe('The download is larger than 4000 bytes; stopped')
    expect(await refusal(rt.prepareImport('https://example.com/page.html'))).toBe('https://example.com/page.html did not send a .zip file')
    expect(await refusal(rt.prepareImport('https://example.com/nope.zip'))).toBe('Could not download https://example.com/nope.zip: HTTP 404')
    // http로 넘기는 곳에는 가지 않았다
    expect(asked).not.toContain('http://example.com/a.zip')
    expect(asked).not.toContain('https://127.0.0.1/a.zip')

    const { review, token } = await rt.prepareImport('https://example.com/moved')
    expect(review).toMatchObject({ appId: 'remote', source: 'https://example.com/moved' })
    // 받은 것도 꺼진 채 들어온다
    expect(rt.commitImport(token, { enable: false }).status).toBe('unconfirmed')
    // 내려받은 묶음은 임시 폴더에서 지워졌다
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('centralu-import-'))).toEqual([])
  })
})
