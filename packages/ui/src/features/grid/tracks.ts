/*
 * The track sizes the grid and the project screen (#203) share. Both lay panels out the same
 * way, and a working panel's ring is drawn by the same layer in both, so the fix that keeps the
 * ring whole (#208) has to hold in both — one copy is what makes that true.
 */

/** 칸 사이의 간격(px). 아래 wholePixelTracks가 이 값을 빼고 나누므로 한 자리에 둔다 */
export const GRID_GAP = 8

/**
 * 칸을 **온전한 픽셀** 위에 세운다 (#208).
 *
 * 1fr로 나누면 칸의 폭과 자리가 창 폭을 따라 소수점이 된다. WebKit(실물은 WKWebView)은
 * 그런 칸에서 도는 테두리의 마스크를 칸과 다른 픽셀에 맞춰, 링의 한 변을 통째로 잃었다
 * (실측: 1배율, 세 열, 가운데 칸이 x.328에서 시작하는 폭 — 창 폭 세 번에 한 번 — 에서
 * 오른쪽 변이 사라졌다). 마스크를 네 띠나 clip-path로 바꿔도 같은 자리에서 끊겼고,
 * 칸의 자리가 정수일 때만 온전했다. 그래서 고치는 쪽은 마스크가 아니라 자리다.
 *
 * 마지막 칸을 뺀 모든 칸의 크기를 1px 단위로 내림하고, 남는 몇 픽셀은 마지막 칸이
 * 1fr로 갖는다. 그러면 모든 칸의 시작점이 정수가 되고 격자는 여전히 화면에 딱 맞는다.
 * 창 폭을 JS로 재서 px를 박지 않는 이유: ResizeObserver는 레이아웃 **뒤에** 알려주므로,
 * 창을 끄는 동안 한 프레임씩 옛 폭으로 그려 격자가 넘치거나 빈다. 100%는 그 프레임의 폭이다.
 */
export function wholePixelTracks(n: number): string {
  if (n <= 1) return 'minmax(0, 1fr)'
  const share = `round(down, calc((100% - ${(n - 1) * GRID_GAP}px) / ${n}), 1px)`
  return `repeat(${n - 1}, ${share}) minmax(0, 1fr)`
}
