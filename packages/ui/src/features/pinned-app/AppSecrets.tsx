import { useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'

/**
 * 앱의 비밀 (M4 E) — 매니페스트가 선언한 이름마다 값이 들어 있는지와, 넣고·바꾸고·지우는 칸.
 *
 * **값은 돌아오지 않는다.** host는 목록에 있음·없음만 싣고(값이 방송을 타지 않게), 이 칸은 보낸 값을 곧바로 잊는다. 그래서
 * "Replace"는 옛 값을 보여 주고 고치는 칸이 아니라 새 값을 받는 빈 칸이다. 비밀번호 칸이라 화면을 나누는 중에 넣어도 글자가
 * 보이지 않는다. 넣은 값은 앱이 **다음에 뜰 때** 받는다(떠 있던 앱은 host가 호출을 마친 뒤 내린다) — 그 사실을 한 줄로 말한다.
 *
 * 고정 화면의 판과 설정의 앱 줄이 이 하나를 같이 쓴다.
 */
export function AppSecrets({ app }: { app: ExternalCatalogApp }) {
  const slots = app.info.secrets ?? []
  if (slots.length === 0) return null
  return (
    <div data-testid="app-secrets">
      <ul className="space-y-2">
        {slots.map((s) => (
          <SecretRow key={s.name} app={app} name={s.name} set={s.set} />
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-relaxed text-slate">
        Values stay on this machine and are never shown again. The app gets a new value the next time it starts.
      </p>
    </div>
  )
}

function SecretRow({ app, name, set }: { app: ExternalCatalogApp; name: string; set: boolean }) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const refresh = useStore((s) => s.refreshExternalApps)
  // 칸을 여는 것은 비어 있을 때와 "Replace"를 눌렀을 때뿐이다 — 들어 있는 값을 가리는 칸을 늘 세워 두지 않는다
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = !set || editing

  const write = async (value: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await platform.apps.setSecret(app.appId, app.projectId, name, value)
      // 보냈으면 잊는다 — 이 칸이 값을 들고 있을 까닭이 더는 없다
      setDraft('')
      setEditing(false)
      setToast(value === null ? `Cleared ${name}` : `Saved ${name}. ${app.title} gets it the next time it starts`)
      void refresh()
    } catch (e) {
      // host의 말 그대로 — 그 말에는 값이 없다(host가 싣지 않는다)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded border border-edge bg-void px-2.5 py-2" data-testid={`secret-${name}`} data-set={set || undefined}>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="min-w-0 truncate font-mono text-chalk">{name}</span>
        <span className={`readout ml-auto shrink-0 ${set ? 'text-slate' : 'text-chalk'}`} data-testid="secret-state">
          {set ? 'Set' : 'Missing'}
        </span>
        {set && !editing && (
          <>
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-slate transition-colors hover:text-chalk"
              onClick={() => setEditing(true)}
              disabled={busy}
              data-testid="secret-replace"
            >
              Replace
            </button>
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-slate transition-colors hover:text-beacon"
              onClick={() => void write(null)}
              disabled={busy}
              data-testid="secret-clear"
            >
              Clear
            </button>
          </>
        )}
      </div>
      {open && (
        <form
          className="mt-1.5 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft && !busy) void write(draft)
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={set ? 'New value' : 'Value'}
            aria-label={`Value for ${name}`}
            className="min-w-0 flex-1 rounded border border-edge bg-pit px-2 py-1 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
            data-testid="secret-input"
          />
          {editing && (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-1 text-[11px] text-slate transition-colors hover:text-chalk"
              onClick={() => {
                setDraft('')
                setEditing(false)
                setError(null)
              }}
            >
              Cancel
            </button>
          )}
          <button
            className="shrink-0 rounded border border-edge bg-panel px-2 py-1 text-[11px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
            disabled={!draft || busy}
            data-testid="secret-save"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
      {error && (
        <p className="mt-1 break-words text-[11px] text-ash" role="alert" data-testid="secret-error">
          {error}
        </p>
      )}
    </li>
  )
}

/** 고정 화면 옆에 여닫는 판 (기록 판과 같은 자리·모양) — 앱을 쓰다가 키가 빠진 것을 알게 되는 자리가 여기다 */
export function SecretsPanel({ app }: { app: ExternalCatalogApp }) {
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-edge bg-pit" data-testid="secrets-panel" aria-label="Secrets">
      <header className="flex h-8 shrink-0 items-center border-b border-edge px-3">
        <span className="readout text-[10px] uppercase text-slate">Secrets</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <AppSecrets app={app} />
      </div>
    </aside>
  )
}

/** 비어 있는 비밀의 수 — 고정 화면의 머리글과 설정의 줄이 "무엇이 빠졌나"를 한 마디로 말한다 */
export function missingSecrets(app: ExternalCatalogApp | undefined): number {
  return app?.info.secrets?.filter((s) => !s.set).length ?? 0
}
