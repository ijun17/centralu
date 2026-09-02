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

/** 점 셋 — "여기에 더 있다". 글리프(⋯)가 아니라 도형이라 폰트를 타지 않는다 */
export function DotsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
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
      <path
        d="M6 3.5L10.5 8L6 12.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

/**
 * 이름 고치기 — 연필.
 *
 * 글자('Rename')를 쓰지 않는 이유는 이 자리(세션 줄 오른쪽 끝)가 삭제 버튼과
 * 나란히 서는 좁은 칸이라, 글자를 넣으면 줄마다 이름이 잘리기 때문이다.
 * 연필은 "고친다"의 거의 표준 기호라 아이콘으로 바꿔도 뜻이 약해지지 않는다.
 */
export function PencilIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11.2 2.3l2.5 2.5-8 8-3.2.7.7-3.2 8-8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Run — a filled triangle.
 *
 * Filled, where the chevron next door deliberately is not. That note is about *font*
 * triangles: their weight and alignment belong to whichever font drew them, which is why
 * they lost to a drawn chevron. Drawn here, the solid mark is the right one — "run" is a
 * button you press, and an outline reads as a shape being described rather than pressed.
 */
/**
 * 실행 — 재생 삼각형.
 *
 * 예전 삼각형은 16짜리 화판 안에서 7 × 9.2밖에 안 차지했고, 그걸 13px로 그렸다. 옆에
 * 나란히 서는 재시작 아이콘은 지름 11의 원을 14px로 그리니, **같은 줄에서 잉크의 폭이
 * 두 배 가까이 차이 났다.** 크기 숫자만 보면 13과 14로 비슷했는데도 눈에는 작았던 이유가
 * 그것이다 — 화판이 아니라 잉크가 크기를 정한다.
 *
 * 그래서 화판을 더 채우고(8.8 × 10.8) 15px로 그린다. 꼭짓점은 둥글다: 이 파일의 다른
 * 아이콘은 전부 `strokeLinecap="round"`라, 칼같이 뾰족한 삼각형 하나만 혼자 다른
 * 물건처럼 보였다.
 */
export function PlayIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4.6 3.1a.9.9 0 011.37-.76l7.1 4.9a.9.9 0 010 1.52l-7.1 4.9A.9.9 0 014.6 12.9z"
        fill="currentColor"
      />
    </svg>
  )
}

/**
 * 다시 시작 — 원을 그리는 화살표.
 *
 * "Restart"라는 글자를 아이콘으로 바꾸면 뜻이 약해지므로, 거의 표준에 가까운
 * 기호를 쓴다. 화살촉이 있어야 '되돌린다'가 아니라 '다시 돈다'로 읽힌다.
 */
/**
 * 인수인계 — 상자에서 오른쪽으로 나가는 화살표 (로그아웃 계열 글리프).
 * "여기 것을 밖의 새 자리로 옮긴다"로 읽힌다. 재시작(원형 화살표)과 모양이 달라야
 * 하는 이유: 하나는 같은 대화를 다시 잇는 것이고 하나는 대화를 갈아타는 것이다.
 */
export function HandoffIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6.5 2.5H4a1.5 1.5 0 00-1.5 1.5v8A1.5 1.5 0 004 13.5h2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M10 5l3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.5 8H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function RestartIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13.5 8a5.5 5.5 0 11-1.61-3.89"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M13.5 2v3.2h-3.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * 갈라지는 줄기 — 워크트리 매니저 (#76).
 *
 * 점 세 개와 선으로 그린 브랜치는 거의 표준에 가까운 기호라, 이 앱에서 처음 보는
 * 버튼인데도 "깃의 무언가"로는 바로 읽힌다. 왕관(오케스트레이터)과 헷갈릴 일도 없다:
 * 하나는 자리이고 하나는 갈래라, 모양이 말하는 것이 서로 다르다.
 */
export function BranchIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 5.1v5.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* 줄기에서 갈라져 나온 가지가 다시 아래로 내려온다 — 갈라짐과 되돌아옴이 한 획에 */}
      <path
        d="M11.5 5.1v1.4a2.4 2.4 0 01-2.4 2.4H6.9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
