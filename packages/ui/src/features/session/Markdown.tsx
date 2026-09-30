import { memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStore } from '../../store/store.js'
import { requestViewerJump } from '../viewer/jump.js'
import { parseFileRef, type FileRef } from './filePath.js'

/**
 * Rendering the agent's response.
 *
 * While streaming, the markdown **arrives incomplete** (an open code fence, a truncated link).
 * react-markdown does not throw on that kind of input and just renders the partial result, so
 * this uses it as-is.
 *
 * Styling follows the grayscale rule — code and quotes are set apart by background brightness
 * and spacing, not color.
 *
 * `projectRoot` is the session's project directory, or null when it has none (the
 * orchestrator). It is what decides whether a backticked path is a file the person can open —
 * see `parseFileRef`.
 */
export const Markdown = memo(function Markdown({
  text,
  projectRoot,
  projectId = null,
}: {
  text: string
  projectRoot: string | null
  /** The project of the file the link opens — the owner of projectRoot (#182) */
  projectId?: string | null
}) {
  return (
    <div className="cc-md max-w-[80ch] text-chalk/90" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          /*
           * Links branch three ways (extended in #39):
           *  - If href is a file in this project, it is the same file link as a backticked
           *    path — the agent also writes things like `[manager.ts](packages/.../manager.ts)`,
           *    and that used to be a dead link.
           *  - http(s) and mailto open in a new window (navigating inside the app would lose
           *    the session).
           *  - Any other href is **never put into the DOM.** The rule that a string produced
           *    by a model must not sit in an attribute the browser would interpret (see the
           *    `code` comment below) holds just as much for `a` — leaving only the text is the
           *    honest rendering.
           */
          a: ({ node: _node, href, children, ...props }) => {
            const ref = typeof href === 'string' ? parseFileRef(tryDecode(href), projectRoot) : null
            if (ref) return <FileLink refInfo={ref} projectId={projectId}>{children}</FileLink>
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
              <FileLink refInfo={ref} projectId={projectId}>
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

/** A link's href may be percent-encoded — if it cannot be decoded, judge it on the raw text */
function tryDecode(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/**
 * A single file link inside the conversation — a backticked path and a markdown link are the
 * same button. Click opens the read-only viewer (#39), right-click opens Finder. Right-click
 * opens directly instead of showing a menu because a menu with only one entry just slows the
 * hand down (the file tree has several entries, so a menu makes sense there).
 */
/*
 * The link carries and opens with its own project (#182). The path is relative to this pane's
 * session's project, so if the viewer picked its project from whichever session is focused, a
 * link in the neighboring pane of the grid would open the same path in a different project —
 * WKWebView does not give focus on a button click, so a pane's onFocusCapture cannot move focus.
 */
function FileLink({
  refInfo,
  projectId,
  children,
}: {
  refInfo: FileRef
  projectId: string | null
  children: ReactNode
}) {
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
        openFile(refInfo.path, projectId)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void revealFile(refInfo.path, projectId)
      }}
    >
      {children}
    </button>
  )
}
