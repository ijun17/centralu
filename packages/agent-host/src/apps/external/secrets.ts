import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 앱 비밀의 값 (M4 A-3, 플랜 "데이터와 비밀은 저장소 밖이다").
 *
 * 매니페스트에는 **이름만** 적힌다(커밋되어 팀과 나뉘므로). 값은 이 기계의 host 데이터
 * 폴더에 권한 0600 파일 하나로 산다 — v1은 키체인 대신 파일이다(플랜이 둘 다 허용한다).
 * 앱마다 칸이 나뉘고, 앱이 **선언한 이름만** 그 앱의 환경 변수로 들어간다: 값이 저장돼
 * 있어도 매니페스트에서 이름을 지우면 그 앱은 더 이상 받지 못한다.
 *
 * 이 파일은 값을 어디에도 적지 않는다(로그·실행 기록·오류 문구). 값을 가리는 일은
 * 쓰는 쪽(`redactor`)이 한다 — 가려야 할 값의 목록을 아는 곳이 여기라서 함께 둔다.
 */

export const SECRETS_FILE = 'app-secrets.json'

type SecretsDoc = Record<string, Record<string, string>>

export class SecretStore {
  private path: string

  constructor(dataRoot: string) {
    this.path = join(dataRoot, SECRETS_FILE)
  }

  /** 이 앱의 저장된 값 전부 (선언과 무관) */
  all(appKey: string): Record<string, string> {
    return { ...(this.read()[appKey] ?? {}) }
  }

  /** 앱에 넘길 값 — 매니페스트가 선언한 이름만 */
  forApp(appKey: string, declared: readonly string[]): Record<string, string> {
    const stored = this.read()[appKey] ?? {}
    const out: Record<string, string> = {}
    for (const name of declared) {
      const v = stored[name]
      if (typeof v === 'string') out[name] = v
    }
    return out
  }

  /** 값을 적거나(`value`) 지운다(`null`) */
  set(appKey: string, name: string, value: string | null): void {
    const doc = this.read()
    const cur = { ...(doc[appKey] ?? {}) }
    if (value === null) delete cur[name]
    else cur[name] = value
    if (Object.keys(cur).length === 0) delete doc[appKey]
    else doc[appKey] = cur
    /*
     * 임시 파일을 **처음부터 0600으로** 만들고 옮긴다. 쓰고 나서 chmod하면 그 사이에
     * 기본 권한(보통 0644)으로 읽히는 순간이 생긴다. 옮긴 뒤 한 번 더 조이는 것은 이미
     * 있던 파일을 누가 풀어 두었을 때를 위해서다.
     */
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 })
    renameSync(tmp, this.path)
    chmodSync(this.path, 0o600)
  }

  private read(): SecretsDoc {
    if (!existsSync(this.path)) return {}
    try {
      const doc = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as SecretsDoc) : {}
    } catch {
      // 깨진 파일은 빈 것으로 — 값을 추측해 넘기느니 앱이 "비밀이 없다"고 말하게 둔다
      console.error(`[apps] ${SECRETS_FILE} is unreadable; apps start without secrets`)
      return {}
    }
  }
}

/**
 * 비밀 값을 `[redacted:이름]`으로 바꾸는 함수. 값이 없으면 그대로 돌려주는 항등 함수다.
 *
 * 긴 값부터 바꾼다 — 한 비밀이 다른 비밀의 일부이면(토큰과 그 접두어) 짧은 쪽을 먼저
 * 바꿨을 때 긴 쪽의 나머지가 남는다. 4자 미만 값은 가리지 않는다: `a`나 `1` 같은 값을
 * 가리면 기록 전체가 누더기가 되고, 그런 값은 비밀로서도 의미가 없다.
 */
export function redactor(secrets: Record<string, string>): (text: string) => string {
  const pairs = Object.entries(secrets)
    .filter(([, v]) => v.length >= 4)
    .sort((a, b) => b[1].length - a[1].length)
  if (pairs.length === 0) return (t) => t
  return (text) => {
    let out = text
    for (const [name, value] of pairs) out = out.split(value).join(`[redacted:${name}]`)
    return out
  }
}
