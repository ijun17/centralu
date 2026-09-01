import { memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStore } from '../../store/store.js'
import { requestViewerJump } from '../viewer/jump.js'
import { parseFileRef, type FileRef } from './filePath.js'

/**
 * 에이전트 응답 렌더링.
 *
 * 스트리밍 중에는 마크다운이 **미완성 상태로 들어온다** (열린 코드펜스, 잘린 링크).
 * react-markdown은 그런 입력도 던지지 않고 부분 렌더하므로 그대로 쓴다.
 *
 * 스타일은 무채색 규칙을 따른다 — 코드·인용은 색이 아니라 배경 밝기와 여백으로 구분한다.
 *
 * `projectRoot` is the session's project directory, or null when it has none (the
 * orchestrator). It is what decides whether a backticked path is a file you can open —
 * see `parseFileRef`.
 */
export const Markdown = memo(function Markdown({
  text,
  projectRoot,
}: {
  text: string
  projectRoot: string | null
}) {
  return (
    <div className="cc-md max-w-[80ch] text-chalk/90" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          /*
           * 링크 셋 갈래 (#39 확장):
           *  - href가 이 프로젝트의 파일이면 백틱 경로와 같은 파일 링크다 — 에이전트는
           *    `[manager.ts](packages/.../manager.ts)`처럼도 쓰고, 그게 죽은 링크였다.
           *  - http(s)·mailto는 새 창으로 (앱 안에서 이동하면 세션이 날아간다).
           *  - 그 밖의 href는 **DOM에 싣지 않는다.** 모델이 낸 문자열을 브라우저가
           *    해석할 속성에 두지 않는다는 규칙(아래 code 주석)은 a에도 똑같이 성립한다 —
           *    글자만 남기는 것이 정직한 렌더링이다.
           */
          a: ({ node: _node, href, children, ...props }) => {
            const ref = typeof href === 'string' ? parseFileRef(tryDecode(href), projectRoot) : null
            if (ref) return <FileLink refInfo={ref}>{children}</FileLink>
            if (typeof href === 'string' && /^(https?:|mailto:)/i.test(href)) {
              return (
                <a {...props} href={href} target="_blank" rel="noreferrer noopener">
                  {children}
                </a>
              )
            }
            return <>{children}</>
          },
          /*
           * A path the agent typed opens in the viewer (#39).
           *
           * The click can do exactly one thing: hand a string to `openFile`, which reads
           * it through `fs.readFile(projectId, …)` and shows it read-only. That is the
           * safety property, and it is why this is a `<button>` and not an `<a href>` —
           * the text comes out of a model, so there must be no attribute anywhere on this
           * element that a browser would try to *interpret*. No href, therefore no scheme,
           * therefore nothing for `javascript:` to be smuggled into. (Right-click reveal
           * goes through `fs.reveal`, which refuses anything above the project root — the
           * same property, kept on the host side.)
           *
           * `<code>` stays inside so the thing still looks like the code span it was, and
           * so the surrounding `.cc-md` rules (including the `pre code` reset) keep
           * applying untouched.
           *
           * `node` is react-markdown's own handle on the AST and is dropped rather than
           * spread: passed through, it lands in the DOM as `node="[object Object]"`.
           */
          code: ({ node: _node, children, ...props }) => {
            const ref = typeof children === 'string' ? parseFileRef(children, projectRoot) : null
            if (!ref) return <code {...props}>{children}</code>
            return (
              <FileLink refInfo={ref}>
                <code>{children}</code>
              </FileLink>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

/** 링크의 href는 퍼센트 인코딩돼 있을 수 있다 — 못 풀면 원문 그대로 판정한다 */
function tryDecode(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/**
 * 대화 속 파일 링크 하나 — 백틱 경로와 마크다운 링크가 같은 버튼이다.
 * 클릭은 읽기 전용 뷰어(#39), 우클릭은 Finder다. 우클릭이 메뉴가 아니라 바로 여는
 * 이유: 항목이 하나뿐인 메뉴는 손만 느리게 한다 (파일 트리는 항목이 여럿이라 메뉴가 맞다).
 */
function FileLink({ refInfo, children }: { refInfo: FileRef; children: ReactNode }) {
  const openFile = useStore((s) => s.openFile)
  const revealFile = useStore((s) => s.revealFile)
  return (
    <button
      type="button"
      className="cursor-pointer underline decoration-slate underline-offset-2 hover:decoration-chalk"
      title={`Open ${refInfo.path}${refInfo.line === null ? '' : ` at line ${refInfo.line}`} · Right-click: Reveal in Finder`}
      data-testid="file-link"
      onClick={() => {
        // The line goes first: by the time `openFile` renders the viewer, the
        // row it should land on has to already be waiting for it.
        if (refInfo.line !== null) requestViewerJump(refInfo.path, refInfo.line)
        openFile(refInfo.path)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void revealFile(refInfo.path)
      }}
    >
      {children}
    </button>
  )
}
