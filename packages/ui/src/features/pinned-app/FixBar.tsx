import { useLayoutEffect, useRef, useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { CloseIcon, PlusIcon, SendIcon } from '../../components/icons.jsx'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { useStore, type ChatAttachment, type PinnedView } from '../../store/store.js'
import { isComposerSendKey } from '../session/composerKeys.js'
import type { AppBuilder } from './useAppBuilder.js'

/** 입력줄이 자라는 한계 — 네 줄쯤. 넘으면 칸 안에서 구른다(화면을 밀어내지 않는다) */
const MAX_H = 96

/**
 * "여기를 고쳐 줘" 줄 (M4 C-5) — 고정 화면 아래의 얇은 입력줄. 여기 쓴 말은 이 앱의 만드는 세션으로 간다.
 *
 * **사람은 앱을 떠나지 않는다.** 보내도 화면은 그대로이고, 보냈다는 한 줄과 그 대화를 옆에 여는 길("Show")만 남는다.
 * 어느 앱의 어느 화면에서 왔는지는 host가 머리말로 붙인다(`apps.askBuilder`) — 이 줄이 적어 보내지 않는다. 앱이
 * 멈췄거나 마지막 실행이 실패했으면 그 사실도 host가 싣는다: "이 버튼이 안 된다"는 말은 그 실패와 함께 가야 한다.
 *
 * 붙여 넣은 스크린샷은 입력창과 **같은 길**로 붙는다(`attachFile` → 만드는 세션의 첨부 폴더). 앱 화면을 직접 찍어
 * 붙이는 것은 다음 단계다(플랜 C-5: WKWebView가 그 길을 열어 주지 않는다).
 *
 * 만드는 세션이 없으면(손으로 만든 앱, 지운 세션, 만들 때 서지 못한 세션) 입력줄 대신 그 사실과 세우는 단추를 둔다.
 * 신뢰하지 않은 프로젝트의 앱에는 세울 수 없으므로 아무것도 두지 않는다.
 */
export function FixBar({
  app,
  pv,
  builder,
  onShowBuilder,
}: {
  app: ExternalCatalogApp | undefined
  pv: PinnedView
  builder: AppBuilder
  onShowBuilder: () => void
}) {
  const platform = usePlatform()
  const attachFile = useStore((s) => s.attachFile)
  const sendWithModifierEnter = useStore((s) => s.prefs.sendWithModifierEnter)
  const builderName = useStore((s) => (builder.id ? s.sessions[builder.id]?.name : undefined))
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [busy, setBusy] = useState(false)
  /** 방금 보낸 곳 — 다시 쓰기 시작하면 걷힌다 */
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 높이는 값에서 나온다 (입력창과 같은 규칙 — 보내고 비우면 높이도 돌아온다)
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`
  }, [text])

  if (!app || !app.info.trusted || builder.id === undefined) return null

  if (builder.id === null) {
    return (
      <div className="mt-2 flex items-center gap-3 rounded border border-dashed border-edge px-3 py-1.5 text-[12px]" data-testid="fix-bar-no-builder">
        <p className="min-w-0 flex-1 text-ash">
          {app.title} has no builder session, so there is no one to ask for changes.
          {builder.error && (
            <span className="block whitespace-pre-wrap break-words text-slate" role="alert" data-testid="fix-bar-error">
              {builder.error}
            </span>
          )}
        </p>
        <button
          type="button"
          className="shrink-0 rounded border border-edge bg-void px-2.5 py-0.5 text-chalk transition-colors hover:border-graphite disabled:opacity-40"
          onClick={() => void builder.start()}
          disabled={builder.starting}
          data-testid="fix-bar-start-builder"
        >
          {builder.starting ? 'Starting…' : 'Start builder'}
        </button>
      </div>
    )
  }

  const builderId = builder.id
  const takeFiles = async (files: FileList | File[] | null) => {
    if (!files) return
    for (const f of Array.from(files)) {
      const att = await attachFile(builderId, f)
      if (att) setAttachments((prev) => [...prev, att])
    }
  }
  const canSend = !busy && (text.trim() !== '' || attachments.length > 0)
  const submit = async () => {
    if (!canSend) return
    setBusy(true)
    setError(null)
    try {
      // 바이트(data)는 이 줄의 썸네일용이다 — host에는 저장된 경로만 간다(입력창과 같다)
      const files = attachments.map(({ data: _data, ...a }) => a)
      await platform.apps.askBuilder({
        appId: app.appId,
        projectId: app.projectId,
        text,
        ...(files.length ? { attachments: files } : {}),
        ...(pv.instanceId ? { instanceId: pv.instanceId } : {}),
      })
      setText('')
      setAttachments([])
      setSent(builderName ?? 'the builder')
    } catch (e) {
      // host의 말 그대로 — 쓴 글과 첨부는 남긴다(다시 보낼 수 있게)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="mt-2 shrink-0"
      data-testid="fix-bar"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      {attachments.length > 0 && (
        <ul className="mb-1 flex flex-wrap gap-1.5" data-testid="fix-bar-attachments">
          {attachments.map((a, i) => (
            <li key={`${a.path}-${i}`} className="flex items-center gap-1.5 rounded border border-edge bg-panel px-2 py-0.5 text-[11px] text-ash">
              <span className="readout text-[9px] text-slate">{a.kind === 'image' ? 'IMG' : 'DOC'}</span>
              <span className="max-w-40 truncate">{a.name}</span>
              <button
                type="button"
                className="text-slate transition-colors hover:text-chalk"
                onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                aria-label={`Remove attachment ${a.name}`}
              >
                <CloseIcon size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-1.5 rounded border border-edge bg-panel px-2.5 py-1 transition-colors focus-within:border-graphite">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setSent(null)
          }}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing || e.key === 'Process'
            const key = { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, composing }
            if (isComposerSendKey(key, sendWithModifierEnter)) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length === 0) return
            e.preventDefault()
            setSent(null)
            void takeFiles(files)
          }}
          placeholder={`Ask ${builderName ?? 'the builder'} to change this app…`}
          aria-label={`Ask the builder of ${app.title} to change it`}
          className="max-h-24 min-h-[20px] flex-1 resize-none bg-transparent py-0.5 text-[12px] leading-relaxed text-chalk placeholder:text-slate focus:outline-none"
          data-testid="fix-bar-input"
        />
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void takeFiles(e.target.files)} />
        <IconButton label="Attach a screenshot" onClick={() => fileRef.current?.click()} testId="fix-bar-attach" placement="top" className="shrink-0">
          <PlusIcon size={13} />
        </IconButton>
        <IconButton type="submit" label="Send to the builder" disabled={!canSend} testId="fix-bar-send" placement="top" align="right" className="shrink-0 text-ash">
          <SendIcon size={14} />
        </IconButton>
      </div>
      {sent && !error && (
        <p className="mt-1 flex items-center gap-2 text-[11px] text-slate" role="status" data-testid="fix-bar-sent">
          <span className="truncate">Sent to {sent}.</span>
          <button type="button" className="shrink-0 text-ash underline-offset-2 hover:text-chalk hover:underline" onClick={onShowBuilder} data-testid="fix-bar-show-builder">
            Show the conversation
          </button>
        </p>
      )}
      {error && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-ash" role="alert" data-testid="fix-bar-error">
          {error}
        </p>
      )}
    </form>
  )
}
