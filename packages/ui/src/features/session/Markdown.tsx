import { startNumberedLists } from '@cc/core'
import { errorMessage } from '@cc/protocol/client'
import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Options, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useCapability } from '../../app/PlatformProvider.jsx'
import { Modal } from '../../components/Modal.jsx'
import { useStore } from '../../store/store.js'
import { requestViewerJump } from '../viewer/jump.js'
import { isImageLinkPath, localLinkPath, parseFileRef, parseMarkdownFileRef, type FileRef } from './filePath.js'
import { advanceSplit, piecesOf, type MarkdownSplit } from './markdownBlocks.js'
import { loadReplyImage, localImagePath } from './localImages.js'
import { ReplyImage } from './ReplyImage.jsx'

/**
 * Rendering the agent's response. While streaming, the markdown arrives incomplete (an open code fence, a truncated
 * link); react-markdown renders the partial result without throwing, so it is used as-is. Code and quotes are set
 * apart by background brightness and spacing, not color.
 *
 * `projectRoot` is the session's project directory (null for the assistant): it decides whether a backticked path is a
 * file the person can open (`parseFileRef`). `sessionId` is given only for an agent's reply: a local image or external
 * file link in it is verified by that session's host against the session's replies before reading or revealing.
 */
export const Markdown = memo(function Markdown({
  text: written,
  projectRoot,
  projectId = null,
  sessionId = null,
  linkSessionId = null,
  tone = 'normal',
}: {
  text: string
  projectRoot: string | null
  /**
   * `muted` is for text that is the path to the answer rather than the answer (a reasoning row, #58): one step down
   * the ink rule, and every ink `.cc-md` sets on its own (bold, links, headings, table headers) follows it down.
   */
  tone?: MarkdownTone
  /** The project of the file the link opens — the owner of projectRoot (#182) */
  projectId?: string | null
  /** The session whose reply this is; null where a local image or external file link is not to be read/revealed */
  sessionId?: string | null
  /** The session whose folder projectRoot is: a link reads the file through it, from its worktree (#1209) */
  linkSessionId?: string | null
}) {
  /*
   * While a reply streams, its finished blocks are rendered once and kept, and only the block still being written is
   * parsed again per delta (markdownBlocks.ts, #364). The split lives with this mounted reply: a row drawn again
   * starts from the whole text, one parse, as a reply read from history always is. The blocks are joined with the
   * line break react-markdown itself puts between top-level blocks, so the page is the same as one parse of the whole.
   */
  const split = useRef<MarkdownSplit | null>(null)
  // A numbered list that starts at 2 or more right under a line of prose is a list here as it is to the writer (#2242)
  const text = startNumberedLists(written)
  if (split.current?.text !== text) split.current = advanceSplit(split.current, text)
  return (
    <div className={`cc-md max-w-[80ch] ${TONE_CLASS[tone]}`} data-testid="markdown">
      {piecesOf(split.current).map((piece, i) => (
        <Fragment key={i}>
          {i > 0 && '\n'}
          <MarkdownBlock
            text={piece}
            projectRoot={projectRoot}
            projectId={projectId}
            sessionId={sessionId}
            linkSessionId={linkSessionId}
          />
        </Fragment>
      ))}
    </div>
  )
})

export type MarkdownTone = 'normal' | 'muted'

/*
 * `.cc-md` gives bold, links, headings and table headers an ink of their own, which beats an ink inherited from the
 * root, so `muted` names each of them. Code chips keep the text's ink, as in a reply; a table's cells are already muted.
 * Written out whole: Tailwind finds a class by its text.
 */
const TONE_CLASS: Record<MarkdownTone, string> = {
  normal: 'text-ink/90',
  muted: 'text-ink-muted [&_strong]:text-ink-muted [&_a]:text-ink-muted [&_h1]:text-ink-muted [&_h2]:text-ink-muted [&_h3]:text-ink-muted [&_h4]:text-ink-muted [&_th]:text-ink-muted',
}

/*
 * GitHub's Markdown, except that only a double tilde strikes text through (owner, 2026-10-18). GFM's default also
 * strikes `~text~`, and Korean writes a range with one tilde: "1~3일, 5~7일" would strike "3일, 5" through. `~~text~~` still
 * strikes, as it does on GitHub. One array for every block, so react-markdown does not see new plugins each render.
 */
const REMARK_PLUGINS: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }]]

/** One run of top-level blocks; memoised on its text, so a finished block is not parsed again */
export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  projectRoot,
  projectId,
  sessionId = null,
  linkSessionId = null,
}: {
  text: string
  projectRoot: string | null
  projectId: string | null
  sessionId?: string | null
  linkSessionId?: string | null
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={keepLocalDestinations}
      components={{
        /*
         * An image branches the way a link does. A web address is an ordinary `<img>`, as before (the desktop CSP
         * decides whether it loads; it is not widened here). A file path never reaches `src`: the window could not
         * load it anyway, which is what drew WKWebView's broken-image mark, so the session's host reads it and the
         * bytes come back as a `data:` URL (`ReplyImage`). Anything else (`data:`, `javascript:`) the URL rule has
         * already emptied, and only the alt text is left, like an `a` whose href is not kept.
         */
        img: ({ node: _node, src, alt, ...props }) => {
          const label = typeof alt === 'string' ? alt : ''
          if (typeof src !== 'string' || !src) return label ? <span>{label}</span> : null
          if (/^https?:/i.test(src)) return <img {...props} src={src} alt={label} />
          const path = localImagePath(src)
          if (path === null) return label ? <span>{label}</span> : null
          if (!sessionId) return <span className="readout text-ink-faint">{label || path}</span>
          return <ReplyImage key={path} path={path} alt={label} sessionId={sessionId} />
        },
        /*
         * Links branch four ways (#39):
         *  - http(s) and mailto open in a new window (navigating inside the app would lose
         *    the session).
         *  - If href is a file in this project (including `file://`, `#L10-L20`, non-ASCII), it
         *    opens in the read-only viewer (`FileLink`).
         *  - If href is another local file/folder named in a session reply (e.g. `~/Downloads/...`),
         *    it renders as `ExternalFileLink` (in-app preview for images, host-verified reveal in
         *    the file manager — never arbitrary OS execution, never placed in a DOM `href`).
         *  - Any other href is **never put into the DOM.** Leaving only the text is the honest rendering.
         */
        a: ({ node: _node, href, children, ...props }) => {
          if (typeof href === 'string' && /^(https?:|mailto:)/i.test(href)) {
            return (
              <a
                {...props}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                /*
                 * Opened through the platform, like terminal links and apps' links: the desktop's WebView does not
                 * open a new window for target="_blank" by itself. The href stays for hover, copy and the context menu.
                 */
                onClick={(e) => {
                  const platform = useStore.getState().platform
                  if (!platform) return
                  e.preventDefault()
                  void platform.system.openUrl(href).catch((err: unknown) =>
                    useStore.getState().setToast(`Could not open the link: ${errorMessage(err)}`),
                  )
                }}
              >
                {children}
              </a>
            )
          }
          if (typeof href === 'string') {
            const ref = parseMarkdownFileRef(href, projectRoot)
            if (ref) {
              return (
                <FileLink refInfo={ref} projectId={projectId} sessionId={linkSessionId}>
                  {children}
                </FileLink>
              )
            }
            const local = sessionId ? localLinkPath(href) : null
            if (local && sessionId) {
              return (
                <ExternalFileLink key={local} written={local} sessionId={sessionId}>
                  {children}
                </ExternalFileLink>
              )
            }
          }
          return <>{children}</>
        },
        /*
         * A path the agent typed opens in the viewer (#39). The click only hands a string to `openFile`, which reads it
         * through `fs.readFile(projectId, …)` read-only. That is why this is a `<button>`, not an `<a href>`: the text
         * comes from a model, so no attribute here may be one a browser would interpret (no href, no `javascript:`).
         * `<code>` stays inside so the `.cc-md` rules keep applying. `node` is dropped, not spread: passed through,
         * it lands in the DOM as `node="[object Object]"`.
         */
        code: ({ node: _node, children, ...props }) => {
          const ref = typeof children === 'string' ? parseFileRef(children, projectRoot) : null
          if (!ref) return <code {...props}>{children}</code>
          return (
            <FileLink refInfo={ref} projectId={projectId} sessionId={linkSessionId}>
              <code>{children}</code>
            </FileLink>
          )
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
})

/**
 * react-markdown's URL rule, except that local file paths (including `file://`) are kept for our `img` and `a`
 * components, which never place local paths in a DOM `src` or `href` attribute. Unsafe schemes (`javascript:`, `data:`)
 * still fall through to `defaultUrlTransform` and are emptied.
 */
const keepLocalDestinations: UrlTransform = (url, key, node) => {
  if (key === 'src' && node.tagName === 'img' && localImagePath(url) !== null) return url
  if (key === 'href' && node.tagName === 'a' && localLinkPath(url) !== null) return url
  return defaultUrlTransform(url)
}

/**
 * A backticked path or a Markdown link: a click opens the viewer (#39), a right-click reveals the file at once (a menu of
 * one entry only slows the hand). It carries its own project (#182), as WKWebView gives no focus on a button click for a
 * grid pane to take, and its session (#1209), whose worktree the path is relative to, not the main checkout.
 */
export function FileLink({
  refInfo,
  projectId,
  sessionId = null,
  children,
}: {
  refInfo: FileRef
  projectId: string | null
  /** The session whose folder the path is in; null for the project's own */
  sessionId?: string | null
  children: ReactNode
}) {
  const openFile = useStore((s) => s.openFile)
  const revealFile = useStore((s) => s.revealFile)
  // The OS's own name for it, as the file tree's menu and a reply's image say it (#1143 U23)
  const fileManager = useCapability('fileManagerName')
  return (
    <button
      type="button"
      className="cursor-pointer underline decoration-ink-faint underline-offset-2 hover:decoration-ink"
      title={`Open ${refInfo.path}${refInfo.line === null ? '' : ` at line ${refInfo.line}`} · Right-click: Reveal in ${fileManager}`}
      data-testid="file-link"
      onClick={() => {
        // The line goes first: by the time `openFile` renders the viewer, the
        // row it should land on has to already be waiting for it.
        if (refInfo.line !== null) requestViewerJump(refInfo.path, refInfo.line)
        openFile(refInfo.path, projectId, sessionId)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void revealFile(refInfo.path, projectId, sessionId)
      }}
    >
      {children}
    </button>
  )
}

/**
 * A Markdown link to a local file or folder outside `projectRoot` (or in an assistant session with no project).
 * Image links open an in-app preview via `messages.image` (right-click reveals in the file manager); all other
 * local files/folders reveal via `messages.resolveFile` + `reveal_path` so arbitrary files are never executed.
 */
function ExternalFileLink({
  written,
  sessionId,
  children,
}: {
  written: string
  sessionId: string
  children: ReactNode
}) {
  const platform = useStore((s) => s.platform)
  const toast = (msg: string) => useStore.getState().setToast(msg)
  const remote = useStore((s) => !!s.sessions[sessionId]?.machine)
  const fileManager = useCapability('fileManagerName')
  const isImage = isImageLinkPath(written)
  const [preview, setPreview] = useState<{ src: string; file?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const busyRef = useRef(false)
  const revealBusyRef = useRef(false)
  const reqIdRef = useRef(0)

  useEffect(() => {
    const id = ++reqIdRef.current
    setPreview(null)
    setLoading(false)
    busyRef.current = false
    revealBusyRef.current = false
    return () => {
      if (reqIdRef.current === id) reqIdRef.current += 1
    }
  }, [written, sessionId])

  const reveal = () => {
    if (!platform || revealBusyRef.current) return
    if (remote) {
      toast('This file is on another machine and cannot be revealed here')
      return
    }
    const id = reqIdRef.current
    revealBusyRef.current = true
    void platform.fs
      .revealMessageFile(sessionId, written)
      .then(
        (res) => {
          if (reqIdRef.current !== id) return
          if (!res.supported) toast(res.reason ?? 'Showing files is not available here')
        },
        (err: unknown) => {
          if (reqIdRef.current !== id) return
          const msg = errorMessage(err)
          toast(msg.includes(written) ? msg : `Could not show ${written}: ${msg}`)
        },
      )
      .finally(() => {
        if (reqIdRef.current === id) revealBusyRef.current = false
      })
  }

  const openImage = () => {
    if (!platform || busyRef.current) return
    const id = reqIdRef.current
    busyRef.current = true
    setLoading(true)
    void loadReplyImage((sid, p) => platform.agents.messageImage(sid, p), sessionId, written)
      .then((answer) => {
        if (reqIdRef.current !== id) return
        if (answer.ok) {
          setPreview({ src: `data:${answer.mime};base64,${answer.data}`, file: answer.file })
          return
        }
        if (!remote && answer.file && (answer.reason === 'too_large' || answer.reason === 'not_an_image')) {
          void platform.fs.revealMessageImage(answer.file).then(
            () => {
              if (reqIdRef.current === id) toast(answer.message)
            },
            () => {
              if (reqIdRef.current === id) toast(answer.message)
            },
          )
          return
        }
        toast(answer.message)
      })
      .catch((err: unknown) => {
        if (reqIdRef.current !== id) return
        const msg = errorMessage(err)
        toast(msg.includes(written) ? msg : `Could not open ${written}: ${msg}`)
      })
      .finally(() => {
        if (reqIdRef.current === id) {
          busyRef.current = false
          setLoading(false)
        }
      })
  }

  const title = isImage
    ? `Preview ${written}${remote ? '' : ` · Right-click: Reveal in ${fileManager}`}`
    : remote
      ? `${written} (on another machine)`
      : `Reveal ${written} in ${fileManager}`

  return (
    <>
      <button
        type="button"
        className={`${loading ? 'cursor-wait' : 'cursor-pointer'} underline decoration-ink-faint underline-offset-2 hover:decoration-ink`}
        title={title}
        aria-busy={loading || undefined}
        data-testid="external-file-link"
        data-path={written}
        onClick={isImage ? openImage : reveal}
        onContextMenu={(e) => {
          e.preventDefault()
          reveal()
        }}
      >
        {children}
      </button>
      {preview && (
        <Modal onClose={() => setPreview(null)} testId="image-lightbox">
          <div className="flex flex-col items-center gap-2">
            <h2 className="sr-only">Image preview: {written}</h2>
            <img
              src={preview.src}
              alt={written}
              className="max-h-[calc(86vh/var(--text-zoom))] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-line"
              onError={() => {
                setPreview(null)
                toast(`Could not decode image: ${written}`)
              }}
            />
            {!remote && preview.file && platform && (
              <button
                type="button"
                className="readout text-xs text-ink-faint underline underline-offset-2 hover:text-ink"
                onClick={() => {
                  const target = preview.file
                  if (!target) return
                  void platform.fs.revealMessageImage(target).then(
                    (res) => {
                      if (!res.supported) toast(res.reason ?? 'Showing files is not available here')
                    },
                    (err: unknown) => toast(`Could not show ${target}: ${errorMessage(err)}`),
                  )
                }}
              >
                Reveal in {fileManager}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}
