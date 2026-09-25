import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppReview } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Modal } from '../../components/Modal.jsx'
import { useStore } from '../../store/store.js'
import { AppReviewDetails } from './AppReviewDetails.jsx'

const inputClass =
  'w-full rounded border border-edge bg-void px-2 py-1.5 font-mono text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none'

/**
 * 앱 가져오기 (M4 E-3) — 폴더, .zip, https의 .zip에서 사용자 폴더로. 딥링크(E-4)도 이 창을 연다.
 *
 * 두 걸음이다. **출처**를 고르고 Review를 누르면 host가 대기실로 옮겨 담아 판정하고(아직 들어온 것이 아니다), **확인**에서 무엇을
 * 돌리는지·쓰겠다는지·원하는 비밀·파일을 본 뒤 들인다. 들인 앱은 꺼진 채 들어온다("Import"). "Import and enable"은 들이며 그 자리에서
 * 켠다 — 사람이 방금 본 창의 열쇠를 그대로 host에 보낸다(사람이 본 것이 켜지는 것이다).
 *
 * 링크가 연 창은 출처를 미리 채워 둘 뿐, **Review를 누르기 전에는 아무것도 읽거나 내려받지 않는다.** 링크를 누른 것은 사람이지만
 * 링크를 지은 것은 남이다 — 이 기계가 남의 주소로 요청을 보내는 것도 사람이 고른 뒤라야 한다.
 */
export function ImportAppDialog() {
  const request = useStore((s) => s.importDialog)
  if (!request) return null
  // 새 요청(다른 링크)이 오면 창을 새로 세운다 — 반쯤 본 확인이 다른 출처의 것과 섞이지 않게
  return <ImportDialogBody key={request.at} source={request.source} fromLink={request.fromLink} />
}

function ImportDialogBody({ source: initial, fromLink }: { source: string; fromLink: boolean }) {
  const platform = usePlatform()
  const close = useStore((s) => s.closeImport)
  const openApp = useStore((s) => s.openApp)
  const setToast = useStore((s) => s.setToast)
  const refresh = useStore((s) => s.refreshExternalApps)
  const [source, setSource] = useState(initial)
  const [staged, setStaged] = useState<{ token: string; review: AppReview } | null>(null)
  const [busy, setBusy] = useState<null | 'reading' | 'importing'>(null)
  const [error, setError] = useState<string | null>(null)
  // 창이 닫히면(취소·esc·바깥) 대기실을 치운다 — 들이지 않은 것을 host에 남기지 않는다
  const pending = useRef<string | null>(null)
  useEffect(() => () => void (pending.current && platform.apps.importCancel(pending.current).catch(() => {})), [platform])

  const review = async () => {
    if (!source.trim() || busy) return
    setBusy('reading')
    setError(null)
    try {
      const got = await platform.apps.importPrepare(source.trim())
      pending.current = got.token
      setStaged(got)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const commit = async (enable: boolean) => {
    if (!staged || busy) return
    setBusy('importing')
    setError(null)
    try {
      const app = await platform.apps.importCommit(staged.token, { enable, reviewKey: staged.review.reviewKey })
      pending.current = null
      void refresh()
      close()
      setToast(enable ? `Imported and enabled ${app.name ?? app.appId}` : `Imported ${app.name ?? app.appId}. It stays off until you enable it`)
      // 들인 앱으로 간다 — 켰으면 앱이, 켜지 않았으면 켜기 전의 확인이 선다
      openApp(app.projectId, app.appId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const back = useCallback(() => {
    if (pending.current) void platform.apps.importCancel(pending.current).catch(() => {})
    pending.current = null
    setStaged(null)
    setError(null)
  }, [platform])

  const pick = async (kind: 'folder' | 'zip') => {
    const picked = kind === 'folder' ? await platform.system.pickDirectory() : await platform.system.pickFile({ title: 'Choose an app .zip', extensions: ['zip'] })
    if (picked) setSource(picked)
  }

  const https = /^https:/i.test(source.trim())
  return (
    <Modal onClose={close} testId="import-app-dialog" align="top">
      <div className="flex max-h-[calc(80vh/var(--text-zoom))] w-[520px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-edge bg-pit shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]">
        <header className="shrink-0 border-b border-edge px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-chalk">
            Import an app <span className="text-slate">·</span> <span className="text-ash">Your apps</span>
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-slate">
            It arrives turned off. You see what it runs before you turn it on.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!staged ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault()
                void review()
              }}
            >
              {fromLink && (
                <p className="rounded border border-edge bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-ash" data-testid="import-from-link">
                  A link asked Centralu to import this app. Nothing is read or downloaded until you choose Review.
                </p>
              )}
              <label className="block">
                <span className="mb-1 block text-[10px] text-ash">Folder, .zip file, or https link to a .zip</span>
                <input
                  autoFocus
                  type="text"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="/Users/you/Downloads/notes.zip"
                  spellCheck={false}
                  className={inputClass}
                  data-testid="import-source"
                />
              </label>
              <div className="flex gap-2">
                <button type="button" className="rounded px-2 py-0.5 text-[11px] text-slate transition-colors hover:text-chalk" onClick={() => void pick('folder')} data-testid="import-pick-folder">
                  Choose folder…
                </button>
                <button type="button" className="rounded px-2 py-0.5 text-[11px] text-slate transition-colors hover:text-chalk" onClick={() => void pick('zip')} data-testid="import-pick-zip">
                  Choose .zip…
                </button>
              </div>
            </form>
          ) : (
            <AppReviewDetails review={staged.review} />
          )}
          {error && (
            <p className="mt-3 whitespace-pre-wrap break-words rounded border border-edge bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-chalk" role="alert" data-testid="import-error">
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-edge px-4 py-2.5">
          {staged ? (
            <>
              <button type="button" className="mr-auto rounded px-2 py-1 text-[12px] text-slate transition-colors hover:text-chalk" onClick={back} disabled={!!busy}>
                Back
              </button>
              <button type="button" className="rounded px-2 py-1 text-[12px] text-slate transition-colors hover:text-chalk" onClick={close} data-testid="import-cancel">
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-edge px-3 py-1 text-[12px] text-ash transition-colors hover:border-graphite hover:text-chalk disabled:opacity-40"
                onClick={() => void commit(false)}
                disabled={!!busy}
                data-testid="import-commit"
              >
                Import
              </button>
              <button
                type="button"
                className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
                onClick={() => void commit(true)}
                disabled={!!busy}
                data-testid="import-enable"
              >
                {busy === 'importing' ? 'Importing…' : 'Import and enable'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="rounded px-2 py-1 text-[12px] text-slate transition-colors hover:text-chalk" onClick={close} data-testid="import-cancel">
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
                onClick={() => void review()}
                disabled={!source.trim() || !!busy}
                data-testid="import-review"
              >
                {busy === 'reading' ? (https ? 'Downloading…' : 'Reading…') : 'Review'}
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
  )
}
