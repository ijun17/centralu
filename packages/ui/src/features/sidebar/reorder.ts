/**
 * 끌어서 순서 바꾸기의 순수한 부분.
 *
 * DOM 이벤트에서 떼어내 두면 "어디에 놓았을 때 어떤 순서가 되는가"를
 * 브라우저 없이 검증할 수 있다 — 끌기 자체보다 이 계산이 틀리기 쉽다.
 */

/** 끌고 있는 것이 무엇인지. 서로 다른 종류가 서로의 자리에 떨어지면 안 된다 */
export const PROJECT_MIME = 'application/x-cc-project'
export const SESSION_MIME = 'application/x-cc-session'

/**
 * `dragged`를 `target`의 앞(before) 또는 뒤로 옮긴 새 순서.
 *
 * 자기 자신에게 떨어뜨리면 원래 순서를 그대로 돌려준다 — 아무 일도 없었던 것처럼.
 * 모르는 id면 역시 그대로다: 목록이 그 사이 바뀌었을 수 있는데,
 * 그때 억지로 끼워 넣는 것보다 아무것도 안 하는 편이 낫다.
 */
export function moveTo(ids: readonly string[], dragged: string, target: string, before: boolean): string[] {
  if (dragged === target) return [...ids]
  if (!ids.includes(dragged) || !ids.includes(target)) return [...ids]

  const rest = ids.filter((id) => id !== dragged)
  const at = rest.indexOf(target)
  rest.splice(before ? at : at + 1, 0, dragged)
  return rest
}

/**
 * 커서가 요소의 위쪽 절반이면 그 앞에 놓는다.
 *
 * 경계를 가운데로 잡으면 "이 줄 위" / "이 줄 아래"가 각각 절반씩이라
 * 어느 쪽으로 갈지 손이 예측할 수 있다.
 */
export function dropsBefore(rect: { top: number; height: number }, clientY: number): boolean {
  return clientY < rect.top + rect.height / 2
}
