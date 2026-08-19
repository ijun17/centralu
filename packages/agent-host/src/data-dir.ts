import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR } from '@cc/protocol'

/**
 * 개명 전 데이터 폴더를 새 이름으로 옮긴다 (`~/.control-center` → `~/.centralu`). (legacy-name)
 *
 * **DB를 열기 전에 딱 한 번 부른다.** 열고 나서 옮기면 열린 파일 핸들과 경로가 어긋난다.
 *
 * 복사가 아니라 `rename`이다 — 같은 파일시스템이라 즉시 끝나고, **중간에 끊겨서 반쪽만
 * 남는 상태가 없다.** 24MB짜리 실사용 DB에 WAL·SHM까지 딸린 폴더라 이 성질이 중요하다.
 * 복사였다면 "절반쯤 옮겨진 대화 기록"이라는 상태가 생긴다.
 *
 * @returns 실제로 옮겼으면 true
 */
export function migrateLegacyDataDir(from: string, to: string): boolean {
  /*
   * **둘 다 있으면 손대지 않는다.**
   *
   * 새 폴더가 이미 있다는 것은 이미 옮겼거나 새로 시작했다는 뜻이다. 둘을 합치는 것은
   * 우리가 판단할 일이 아니다 — 어느 쪽 대화가 진짜인지 우리는 모른다.
   * 옛 폴더는 그대로 남으므로 사용자가 직접 꺼내 볼 수 있다.
   */
  if (!existsSync(from) || existsSync(to)) return false
  try {
    renameSync(from, to)
    return true
  } catch {
    // 못 옮겨도 앱은 떠야 한다 — 새 폴더로 빈 채 시작하고, 옛 것은 손상 없이 남는다.
    // (다른 파일시스템에 있거나 권한이 없는 경우. 조용히 죽는 것보다 낫다)
    return false
  }
}

/**
 * 데이터 폴더의 뿌리 — 첨부·오케스트레이터 홈·워크트리가 전부 이 아래에 산다.
 *
 * **환경변수로 덮을 수 있게 둔 이유:** 그러지 않으면 테스트가 사용자의 진짜 홈에 쓴다.
 * 실제로 겪었다 — `pnpm verify` 한 번에 `~/.centralu/orchestrator`가 생겼고, 그 빈 폴더가
 * "새 폴더가 이미 있으면 손대지 않는다"는 안전장치에 걸려 **진짜 데이터의 이사를 막았다.**
 * 조용히 막혔다는 것이 더 나쁘다.
 *
 * host는 기동할 때 이 값을 자기 데이터 폴더로 고정한다 (dev/prod가 갈린다).
 */
export function dataRoot(): string {
  return process.env.CC_DATA_DIR || join(homedir(), DATA_DIR)
}
