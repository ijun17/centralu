import { useCallback, useEffect, useState } from 'react'
import type { AppPermission, AppRun } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { externalAppKey, useStore } from '../../store/store.js'

/**
 * 한 앱의 실행 기록 (M4 B-7) — 고정 화면 옆에 여닫는 판.
 *
 * "누가 무엇을 실행했는지 남긴다"(A-6)의 로컬 절반이 사람 눈에 닿는 자리다. 화면이 부른 것, 세션의
 * 에이전트가 부른 것, 다른 앱이 중개로 부른 것이 같은 한 길을 지나 한 줄씩 남는다. 앱을 쓰는 사람이
 * "방금 누른 것이 정말 앱에 닿았나", "에이전트가 이 앱으로 무엇을 했나"를 앱을 떠나지 않고 본다.
 *
 * 다시 읽는 때: 판을 열 때, 이 앱에 닿은 호출이 끝날 때마다(`external_app_state_changed`의 카운터),
 * 그리고 사람이 누를 때. 거절된 호출(앱에 닿지 않았다)과 읽기 전용 도구의 호출(아무것도 바꾸지 않았다)에는
 * 그 신호가 없으므로 손으로 다시 읽는 길을 둔다.
 * 실패(앱이 실패를 답했다, host가 거절했다)는 줄 왼쪽의 밝은 선과 이유 한 줄로 드러난다. 밝기는 막힌
 * 것의 몫이라는 팔레트 규칙 그대로다.
 */
export function RunsPanel({ appId, projectId }: { appId: string; projectId: string | null }) {
  const platform = usePlatform()
  const changed = useStore((s) => s.externalAppChanges[externalAppKey(projectId, appId)] ?? 0)
  const sessions = useStore((s) => s.sessions)
  const [runs, setRuns] = useState<AppRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    let alive = true
    platform.apps
      .runs(appId, projectId, 100)
      .then((r) => {
        if (!alive) return
        setRuns(r)
        setError(null)
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [platform, appId, projectId])
  // `changed`가 바뀔 때마다 — 앱에 닿은 호출이 끝났다
  useEffect(() => load(), [load, changed])

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-edge bg-pit" data-testid="runs-panel" aria-label="Runs">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="readout text-[10px] uppercase text-slate">Runs</span>
        <button
          type="button"
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-slate transition-colors hover:text-chalk"
          onClick={() => void load()}
          data-testid="runs-refresh"
        >
          Refresh
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Permissions appId={appId} projectId={projectId} changed={changed} />
        {error && (
          <p className="px-3 py-2 text-[11px] text-ash" role="alert">
            Could not read runs: {error}
          </p>
        )}
        {runs && runs.length === 0 && <p className="px-3 py-3 text-[11px] text-slate">No runs yet.</p>}
        <ol>
          {runs?.map((r) => (
            <RunRow key={r.id} run={r} sessionName={r.callerSessionId ? sessions[r.callerSessionId]?.name : undefined} />
          ))}
        </ol>
      </div>
    </aside>
  )
}

/**
 * 이 앱에 대해 기억된 능력의 답 (M4 D-4) — 사람이 한 번 답한 것이 여기 남는다. 잘못 누른 거절도, 이제는 거두고 싶은 허락도
 * 여기서 잊는다(Forget). 잊으면 다음에 그 능력을 쓰려 할 때 다시 묻는다. 매니페스트의 `uses`가 바뀐 뒤의 옛 답은 더 쓰이지
 * 않는다 — "outdated"로 보인다.
 *
 * 다시 읽는 때: 판을 열 때, 이 앱에 닿은 호출이 끝날 때(답한 뒤 앱이 이어서 일을 마치면 온다), 화면의 물음이 바뀔 때, 잊은 뒤.
 */
function Permissions({ appId, projectId, changed }: { appId: string; projectId: string | null; changed: number }) {
  const platform = usePlatform()
  const asked = useStore((s) => s.appQuestionsVersion)
  const setToast = useStore((s) => s.setToast)
  const [list, setList] = useState<AppPermission[] | null>(null)
  const [again, setAgain] = useState(0)
  useEffect(() => {
    let alive = true
    platform.apps
      .permissions(appId, projectId)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]))
    return () => {
      alive = false
    }
  }, [platform, appId, projectId, changed, asked, again])
  const forget = async (p: AppPermission) => {
    try {
      await platform.apps.forgetPermission(appId, projectId, p.capability)
    } catch (e) {
      setToast(`Could not forget: ${(e as Error).message}`)
    }
    setAgain((n) => n + 1)
  }
  if (!list || list.length === 0) return null
  return (
    <section className="border-b border-edge px-3 py-2" data-testid="runs-permissions">
      <p className="readout text-[10px] uppercase text-slate">Permissions</p>
      <ul className="mt-1 space-y-1">
        {list.map((p) => (
          <li key={p.capability} className="flex items-baseline gap-2 text-[11px]" data-testid="permission-row" data-capability={p.capability} data-decision={p.decision}>
            <span className={`min-w-0 flex-1 break-words ${p.current ? 'text-ash' : 'text-slate line-through'}`} title={p.capability}>
              {p.text}
            </span>
            <span className={`readout shrink-0 ${p.decision === 'deny' ? 'text-chalk' : 'text-slate'}`} data-testid="permission-decision">
              {p.current ? (p.decision === 'allow' ? 'allowed' : 'denied') : 'outdated'}
            </span>
            <button
              type="button"
              className="shrink-0 rounded px-1 text-[10px] text-slate transition-colors hover:text-chalk"
              onClick={() => void forget(p)}
              data-testid="permission-forget"
            >
              Forget
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 사람이 읽는 결말 — 기록의 말(`rejected`)과 화면의 말(refused)은 같은 것이다 */
const STATUS: Record<AppRun['status'], string> = {
  running: 'running',
  ok: 'ok',
  error: 'failed',
  rejected: 'refused',
  cancelled: 'cancelled',
}

const CALLER: Record<AppRun['callerKind'], string> = { view: 'View', session: 'Session', app: 'App' }

function duration(ms: number | null): string {
  if (ms === null) return '…'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function RunRow({ run, sessionName }: { run: AppRun; sessionName: string | undefined }) {
  const failed = run.status === 'error' || run.status === 'rejected'
  const when = new Date(run.createdAt)
  const caller = run.callerKind === 'session' && sessionName ? `${CALLER.session} · ${sessionName}` : CALLER[run.callerKind]
  return (
    <li
      className={`border-b border-l-2 border-edge/60 px-3 py-1.5 text-[11px] ${failed ? 'border-l-chalk' : 'border-l-transparent'}`}
      data-testid="run-row"
      data-status={run.status}
      data-failed={failed || undefined}
    >
      <div className="flex items-baseline gap-2">
        <time className="readout shrink-0 text-slate" dateTime={when.toISOString()} data-testid="run-time">
          {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </time>
        <span className="min-w-0 truncate font-mono text-chalk" data-testid="run-tool">
          {run.tool}
        </span>
        <span className={`readout ml-auto shrink-0 ${failed ? 'text-chalk' : 'text-slate'}`} data-testid="run-status">
          {STATUS[run.status]}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 text-slate">
        <span className="truncate" data-testid="run-caller">
          {caller}
        </span>
        <span className="readout ml-auto shrink-0" data-testid="run-duration">
          {duration(run.durationMs)}
        </span>
      </div>
      {failed && run.error && (
        <p className="mt-0.5 line-clamp-2 break-words text-ash" title={run.error} data-testid="run-error">
          {run.error}
        </p>
      )}
    </li>
  )
}
