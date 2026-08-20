/**
 * 화살표로 보낸 말을 되불러오기 (#38).
 *
 * 판단만 떼어낸다 — DOM도 store도 모른다. 그래야 "언제 커서가 움직이고 언제 기록이
 * 올라오는가"를 값으로 시험할 수 있다 (scroll.ts를 떼어낸 것과 같은 이유).
 */

import type { ChatItem } from '../../store/store.js'

/**
 * 보낸 말들, 오래된 것부터.
 *
 * 따로 저장하지 않는다 — 대화에 이미 `{ kind: 'user' }`로 다 있고, 세션마다 나뉘어
 * 있고, 재시작도 견딘다. 기록을 위한 두 번째 저장소를 두면 그 둘이 어긋나는 날이 온다.
 *
 * 연달아 같은 말은 한 번만 센다. 셸과 같은 규칙인데, 이유도 같다: 같은 명령을 두 번
 * 보내는 일은 흔하고(재시도·확인), 그걸 두 칸으로 세면 화살표를 두 번 눌러야 이전
 * 것으로 간다 — 누르는 사람에게는 아무 일도 안 일어난 것처럼 보인다.
 */
export function sentMessages(chat: ChatItem[]): string[] {
  const out: string[] = []
  for (const item of chat) {
    if (item.kind !== 'user') continue
    if (out[out.length - 1] === item.text) continue
    out.push(item.text)
  }
  return out
}

/**
 * 커서가 첫 줄에 있나 / 마지막 줄에 있나.
 *
 * **줄은 개행으로 센다 — 눈에 보이는 줄이 아니라.** 긴 한 줄이 접혀서 세 줄로 보일
 * 때, 그 가운데에서 위 화살표를 누르면 커서가 아니라 기록이 올라온다. 보이는 줄로
 * 세려면 커서의 화면 좌표가 필요하고, textarea에서 그건 거울 DOM을 하나 더 만들어
 * 같은 글꼴·같은 폭으로 매 입력마다 다시 그린다는 뜻이다. 입력창 하나 때문에 치를
 * 값이 아니다.
 *
 * 접히는 줄이 실제로 문제가 되는 폭도 아니다: 입력창은 max-h-40(160px)에서 멈추고,
 * 그보다 긴 글을 쓰는 중이라면 애초에 화살표로 기록을 뒤지는 상황이 아니다.
 */
export const onFirstLine = (text: string, caret: number): boolean => !text.slice(0, caret).includes('\n')

export const onLastLine = (text: string, caret: number): boolean => !text.slice(caret).includes('\n')

/**
 * 화살표 한 번의 결과.
 *
 *   `none`    기록이 나설 자리가 아니다 — 커서를 원래대로 움직여라
 *   `recall`  이 글을 입력창에 앉혀라
 *   `draft`   기록을 다 빠져나왔다 — 쓰다 만 글로 돌아가라
 */
export type HistoryStep = { kind: 'none' } | { kind: 'recall'; at: number; text: string } | { kind: 'draft' }

/**
 * 지금 어디에 있고 어디로 가는가.
 *
 * `at`이 null이면 기록에 들어가 있지 않다 — 입력창에는 쓰다 만 글이 있다.
 *
 * 가장 오래된 것에서 위로 더 가면 **그 자리에 머문다.** 커서를 움직이게 두면
 * "기록이 끝났다"가 "화살표가 안 먹는다"로 보인다.
 */
export function stepHistory(p: { history: string[]; at: number | null; dir: -1 | 1 }): HistoryStep {
  const last = p.history.length - 1
  if (last < 0) return { kind: 'none' }

  if (p.dir === -1) {
    const at = p.at === null ? last : Math.max(0, p.at - 1)
    return { kind: 'recall', at, text: p.history[at]! }
  }

  // 기록 밖에서 아래 화살표는 그냥 커서다 — 되돌아갈 곳이 없다
  if (p.at === null) return { kind: 'none' }
  if (p.at >= last) return { kind: 'draft' }
  return { kind: 'recall', at: p.at + 1, text: p.history[p.at + 1]! }
}
