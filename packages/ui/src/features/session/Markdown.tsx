import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStore } from '../../store/store.js'
import { requestViewerJump } from '../viewer/jump.js'
import { parseFileRef } from './filePath.js'

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
  const openFile = useStore((s) => s.openFile)

  return (
    <div className="cc-md max-w-[80ch] text-chalk/90" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 링크는 새 창으로 (앱 안에서 이동하면 세션이 날아간다)
          a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          /*
           * A path the agent typed opens in the viewer (#39).
           *
           * The click can do exactly one thing: hand a string to `openFile`, which reads
           * it through `fs.readFile(projectId, …)` and shows it read-only. That is the
           * safety property, and it is why this is a `<button>` and not an `<a href>` —
           * the text comes out of a model, so there must be no attribute anywhere on this
           * element that a browser would try to *interpret*. No href, therefore no scheme,
           * therefore nothing for `javascript:` to be smuggled into. Adding any second
           * action to this element would give that text somewhere to go; don't.
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
              <button
                type="button"
                className="cursor-pointer underline decoration-slate underline-offset-2 hover:decoration-chalk"
                title={ref.line === null ? `Open ${ref.path}` : `Open ${ref.path} at line ${ref.line}`}
                data-testid="file-link"
                onClick={() => {
                  // The line goes first: by the time `openFile` renders the viewer, the
                  // row it should land on has to already be waiting for it.
                  if (ref.line !== null) requestViewerJump(ref.path, ref.line)
                  openFile(ref.path)
                }}
              >
                <code>{children}</code>
              </button>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
