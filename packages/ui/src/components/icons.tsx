/**
 * 아이콘.
 *
 * 이모지를 쓰지 않는다. 이모지는 (1) OS·폰트마다 생김새가 달라서 밀도를 맞출 수 없고,
 * (2) 대부분 유채색이라 "색은 diff 본문에만"이라는 이 앱의 규칙을 곧바로 깬다.
 * 선 굵기와 색을 우리가 정하는 SVG면 둘 다 문제가 없다.
 *
 * `currentColor`를 쓰므로 색은 부모의 text-* 가 정한다 — 호버·비활성 상태가 저절로 따라온다.
 */
export function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function CloseIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 펼침 표시 — 꼬리 없는 화살표(셰브런).
 *
 * 접힘은 오른쪽, 펼침은 아래쪽. **같은 글리프를 돌린다**:
 * 두 방향을 각각 그리면 굵기나 크기가 미묘하게 달라져 열고 닫을 때 툭 튀는데,
 * 회전이면 그럴 수가 없다. 도는 동작 자체가 "지금 열렸다"를 말해주기도 한다.
 *
 * 채운 삼각형(▸▾)을 쓰다가 바꿨다 — 삼각형은 폰트가 그리는 것이라
 * 크기·정렬을 우리가 못 정하고, 무게가 글자보다 무거워 목록에서 이름보다 먼저 눈에 띈다.
 */
export function ChevronIcon({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
      aria-hidden
    >
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 보내기. 종이비행기는 "보낸다"의 거의 표준 기호라 글자보다 빨리 읽힌다 */
export function SendIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M14 2L7.2 8.8M14 2L9.6 14.2a.3.3 0 01-.56.02L7.1 9.0 1.9 7.06a.3.3 0 01.02-.56L14 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
