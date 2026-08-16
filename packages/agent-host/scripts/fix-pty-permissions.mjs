/**
 * node-pty의 spawn-helper에 실행 권한을 세운다.
 *
 * 이 파일은 실행 파일인데, 패키지 매니저가 풀어놓을 때 +x가 빠지는 경우가 있다
 * (pnpm의 prebuild 추출에서 실제로 겪었다). 그러면 셸이 뜨지 않고
 * `posix_spawnp failed`만 남아서, 터미널이 통째로 안 되는데 원인은 안 보인다.
 *
 * 설치 후 자동 실행된다 (postinstall).
 */
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

try {
  const root = dirname(require.resolve('node-pty/package.json'))
  const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  if (existsSync(helper)) {
    chmodSync(helper, 0o755)
    console.log(`[node-pty] spawn-helper 실행 권한 확인: ${helper}`)
  }
} catch {
  // node-pty가 없는 환경(웹 전용 CI 등)에서는 조용히 넘어간다
}
