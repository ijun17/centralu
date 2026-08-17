/**
 * 파일 트리에서 입력창으로 경로를 끌어다 놓기.
 *
 * 전용 MIME을 쓴다. 입력창의 드롭 처리는 원래 **OS에서 끌어온 파일**(첨부)을 위한 것이라,
 * 구분하지 않으면 트리에서 끌어온 것도 첨부로 가려다 `dataTransfer.files`가 비어 있어
 * **아무 일도 일어나지 않는다** — 이 프로젝트가 금지하는 조용한 무동작이다.
 *
 * `text/plain`도 함께 싣는다: 다른 곳(터미널·에디터)에 떨어뜨렸을 때도 경로가 나와야 한다.
 */
export const PATH_MIME = 'application/x-cc-path'

export function setDragPath(dt: DataTransfer, path: string): void {
  dt.setData(PATH_MIME, path)
  dt.setData('text/plain', path)
  dt.effectAllowed = 'copy'
}

/** 드롭된 것이 우리 경로인가. 아니면 null — 그때는 첨부 경로로 간다 */
export function readDragPath(dt: DataTransfer): string | null {
  const path = dt.getData(PATH_MIME)
  return path || null
}

/**
 * 입력창에 `@경로`를 이어 붙인다.
 *
 * 자동완성이 `@`로 파일을 넣는 것과 **같은 모양이어야 한다** — 넣는 방법이 둘인데
 * 결과가 다르면 도구가 받는 문장이 달라진다.
 */
export function appendPath(text: string, path: string): string {
  const mention = `@${path}`
  if (!text) return `${mention} `
  return /\s$/.test(text) ? `${text}${mention} ` : `${text} ${mention} `
}
