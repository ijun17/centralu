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

/**
 * `copyMove`인 이유 (#19).
 *
 * 같은 드래그가 **떨어지는 곳에 따라 두 가지**가 됐다: 입력창에 놓으면 경로가 문장에
 * 들어가고(복사), 트리의 폴더에 놓으면 파일이 그리로 옮겨간다(이동). 여기가 `copy`로
 * 고정돼 있으면 트리 쪽에서 `dropEffect = 'move'`를 세우는 순간 브라우저가 그 드롭을
 * **거절한다** — 오류 없이, 그냥 아무 일도 일어나지 않는 모양으로.
 */
export function setDragPath(dt: DataTransfer, path: string): void {
  dt.setData(PATH_MIME, path)
  dt.setData('text/plain', path)
  dt.effectAllowed = 'copyMove'
}

/** 드롭된 것이 우리 경로인가. 아니면 null — 그때는 첨부 경로로 간다 */
export function readDragPath(dt: DataTransfer): string | null {
  const path = dt.getData(PATH_MIME)
  return path || null
}

/**
 * 끌고 있는 것이 우리 경로인가 — **내용을 읽지 않고** 판정한다.
 *
 * `dragover` 동안에는 `getData()`가 빈 문자열을 준다 (브라우저가 드롭 전까지 내용을
 * 가린다). 그래서 "이걸 받을 수 있는가"는 `types`로만 답할 수 있다. 이 구분이 없으면
 * 커서가 무엇을 할지 말해주지 못한 채 손을 놓아야 한다.
 */
export function hasDragPath(dt: DataTransfer): boolean {
  return [...dt.types].includes(PATH_MIME)
}

/** OS에서 끌어온 파일인가 (#19의 '핀더에서 끌어다 넣기') */
export function hasDragFiles(dt: DataTransfer): boolean {
  return [...dt.types].includes('Files')
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
