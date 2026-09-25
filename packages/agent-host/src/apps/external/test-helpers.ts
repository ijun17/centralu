import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST_FILE, MANIFEST_VERSION } from './manifest.js'

/**
 * 외부 앱 테스트가 함께 쓰는 손 — 앱 폴더를 심고, 조건이 설 때까지 기다린다.
 * (테스트 전용 파일이다. 런타임은 이것을 임포트하지 않는다)
 */

export const PROJECT_APPS = ['.centralu', 'apps'] as const

/** `<root>/<...parent>/<id>/centralu.app.json`을 쓴다. over가 null이면 원문 문자열을 쓴다 */
export function plantApp(
  parentDir: string,
  id: string,
  over: Record<string, unknown> = {},
  raw?: string,
): string {
  const dir = join(parentDir, id)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    id,
    name: `App ${id}`,
    version: '0.1.0',
    description: `test app ${id}`,
    server: { command: process.execPath, args: ['server.mjs'] },
    ...over,
  }
  writeFileSync(join(dir, MANIFEST_FILE), raw ?? JSON.stringify(manifest, null, 2))
  return dir
}

/** fs 감시처럼 "곧" 일어나는 일을 기다린다. 시간 안에 안 서면 마지막 값을 들고 실패한다 */
export async function until<T>(read: () => T, ok: (v: T) => boolean, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = read()
  while (!ok(v)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting; last value: ${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 25))
    v = read()
  }
  return v
}
