import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 다리 스크립트의 위치.
 *
 * schema.sql과 같은 문제다: dev(tsx)는 소스 트리에서, 번들된 배포 앱은 산출물 옆에서
 * 읽는다. codex가 `node <경로>`로 직접 띄우므로 **평범한 .mjs 파일이 그 자리에
 * 있어야** 한다 — 번들 스크립트가 함께 복사한다.
 */
export function bridgePath(): string {
  const candidates = [
    new URL('./orchestrator-bridge.mjs', import.meta.url), // 소스 트리
    new URL('./codex-orchestrator-bridge.mjs', import.meta.url), // 번들 산출물 레이아웃
  ].map((u) => fileURLToPath(u))
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`orchestrator bridge not found: ${candidates.join(', ')}`)
  return found
}
