import { useCallback, useEffect, useState } from 'react'
import type { AgentUse, AppPermission, AppRun, AppUsage } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { externalAppKey, useStore } from '../../store/store.js'

/**
 * 한 앱의 실행 기록 (M4 B-7) — 고정 화면 옆에 여닫는 판.
 *
 * "누가 무엇을 실행했는지 남긴다"(A-6)의 로컬 절반이 사람 눈에 닿는 자리다. 화면이 부른 것, 세션의
 * 에이전트가 부른 것, 다른 앱이 중개로 부른 것이 같은 한 길을 지나 한 줄씩 남는다. 앱을 쓰는 사람이
 * "방금 누른 것이 정말 앱에 닿았나", "에이전트가 이 앱으로 무엇을 했나"를 앱을 떠나지 않고 본다.
 *
 * 다시 읽는 때: 판을 열 때, 이 판에 보이는 줄이 서거나 세션이 이어지거나 끝날 때마다(`external_app_runs_changed`의 카운터),
 * 그리고 사람이 누를 때. 그 신호는 host가 기록의 모든 줄에서 낸다 — 거절된 호출도, 읽기 전용 도구의 호출과 그것이 세운 사슬도
 * (앱이 부탁한 에이전트는 몇 분을 돈다). 화면이 듣는 "바뀌었다"(`external_app_state_changed`)에 기대던 동안에는 읽기 전용 도구가
 * 세운 사슬이 Refresh를 누를 때까지 보이지 않았다: 그 신호는 읽기 전용 도구의 호출에 오지 않는다(#190), 그리고 몇 초마다 다시
 * 읽기는 판이 이미 들고 있는 줄이 돌 때만 돌았다.
 * 실패(앱이 실패를 답했다, host가 거절했다)는 줄 왼쪽의 밝은 선과 이유 한 줄로 드러난다. 밝기는 막힌
 * 것의 몫이라는 팔레트 규칙 그대로다.
 *
 * 기록은 사슬로 선다(M4 D-6): 이 앱이 부른 다른 앱의 줄, 이 앱(또는 그 앱)이 Centralu에 부탁한 줄(에이전트·다른 앱·host
 * 데이터)이 그것을 일으킨 줄 아래에 들여 쓰인다. 에이전트를 부탁한 줄에서는 그 세션으로 건너갈 수 있다(Open session).
 */
export function RunsPanel({ appId, projectId }: { appId: string; projectId: string | null }) {
  const platform = usePlatform()
  const changed = useStore((s) => s.externalAppRunChanges[externalAppKey(projectId, appId)] ?? 0)
  const sessions = useStore((s) => s.sessions)
  const apps = useStore((s) => s.externalApps)
  const focusSession = useStore((s) => s.focusSession)
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
  // `changed`가 바뀔 때마다 — 이 판에 보이는 줄이 서거나 끝났다
  useEffect(() => load(), [load, changed])
  const nameOf = (r: AppRun) => apps.find((a) => a.appId === r.appId && a.projectId === r.projectId)?.name ?? r.appId

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
        <AgentUseSection appId={appId} projectId={projectId} runs={runs} />
        {error && (
          <p className="px-3 py-2 text-[11px] text-ash" role="alert">
            Could not read runs: {error}
          </p>
        )}
        {runs && runs.length === 0 && <p className="px-3 py-3 text-[11px] text-slate">No runs yet.</p>}
        <ol>
          {runs &&
            chainRuns(runs).map(({ run: r, depth }) => (
              <RunRow
                key={r.id}
                run={r}
                depth={depth}
                own={r.appId === appId && r.projectId === projectId}
                appName={nameOf(r)}
                sessionName={r.callerSessionId ? sessions[r.callerSessionId]?.name : undefined}
                onOpenSession={r.sessionId && sessions[r.sessionId] ? () => focusSession(r.sessionId) : undefined}
              />
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
 * 다시 읽는 때: 판을 열 때, 이 판의 기록이 바뀔 때(답한 부탁의 줄은 곧 세션을 잇거나 거절로 끝난다), 화면의 물음이 바뀔 때, 잊은 뒤.
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

/**
 * 이 앱이 부탁한 에이전트의 쓰임 (M4 D-5) — 지난 하루와 30일 동안 몇 번, 얼마나 오래, 토큰을 얼마나. 앱은 사람의 에이전트를
 * 빌려 쓴다 — 그 몫이 앱마다 여기 보인다. 고리에 빠진 앱은 이 숫자가 먼저 말한다. 에이전트를 부탁한 적이 없는 앱에는 서지 않는다.
 *
 * 다시 읽는 때: 기록을 다시 읽을 때마다(`runs`가 바뀐다) — 에이전트의 줄이 끝나면 쓰임도 바뀐다.
 */
function AgentUseSection({ appId, projectId, runs }: { appId: string; projectId: string | null; runs: AppRun[] | null }) {
  const platform = usePlatform()
  const [use, setUse] = useState<AppUsage | null>(null)
  useEffect(() => {
    let alive = true
    platform.apps
      .usage(appId, projectId)
      .then((u) => alive && setUse(u))
      .catch(() => alive && setUse(null))
    return () => {
      alive = false
    }
  }, [platform, appId, projectId, runs])
  if (!use || use.month.runs === 0) return null
  return (
    <section className="border-b border-edge px-3 py-2" data-testid="runs-agent-use">
      <p className="readout text-[10px] uppercase text-slate">Agent use</p>
      <dl className="mt-1 space-y-0.5 text-[11px]">
        <UseLine label="24 h" use={use.day} testId="agent-use-day" />
        <UseLine label="30 days" use={use.month} testId="agent-use-month" />
      </dl>
    </section>
  )
}

function UseLine({ label, use, testId }: { label: string; use: AgentUse; testId: string }) {
  const parts = [`${use.runs} ${use.runs === 1 ? 'run' : 'runs'}`, longDuration(use.durationMs)]
  if (use.tokens) parts.push(`${tokenCount(use.tokens.input + use.tokens.output)} tokens`)
  return (
    <div className="flex items-baseline gap-2">
      <dt className="readout w-12 shrink-0 text-slate">{label}</dt>
      <dd className="min-w-0 truncate text-ash" data-testid={testId} title={use.tokens ? `in ${use.tokens.input} · out ${use.tokens.output}` : undefined}>
        {parts.join(' · ')}
      </dd>
    </div>
  )
}

/** 합한 시간 — "42 s", "3m 20s", "2h 5m" */
function longDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** 토큰 수 — "850", "12.4k", "3.1M" */
function tokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * 기록을 사슬로 편다 (M4 D-6) — host는 이 앱의 줄과 그 아래의 사슬을 한 목록(최근 것부터)으로 준다. 부모가 목록에 있는 줄은
 * 그 부모 바로 아래에, 나머지는 맨 위에 선다. 맨 위는 최근 것부터, 한 부모 아래는 **일어난 순서대로** — 한 호출 안의 일은
 * 위에서 아래로 읽혀야 한다. 들여쓰기 깊이를 함께 준다.
 */
export function chainRuns(runs: AppRun[]): { run: AppRun; depth: number }[] {
  const ids = new Set(runs.map((r) => r.id))
  const kids = new Map<string, AppRun[]>()
  const roots: AppRun[] = []
  for (const r of runs) {
    if (r.parentRunId && r.parentRunId !== r.id && ids.has(r.parentRunId)) kids.set(r.parentRunId, [...(kids.get(r.parentRunId) ?? []), r])
    else roots.push(r)
  }
  const out: { run: AppRun; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (r: AppRun, depth: number) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push({ run: r, depth })
    // 받은 목록은 최근 것부터다 — 뒤집으면 같은 시각의 줄까지 일어난 순서가 된다(정렬은 안정적이다)
    for (const c of [...(kids.get(r.id) ?? [])].reverse().sort((a, b) => a.createdAt - b.createdAt)) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  // 부모끼리 서로를 가리키는 줄(있을 수 없지만)도 버리지 않는다
  for (const r of runs) walk(r, 0)
  return out
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

function RunRow({
  run,
  depth,
  own,
  appName,
  sessionName,
  onOpenSession,
}: {
  run: AppRun
  /** 사슬 안의 깊이 — 0은 맨 위 */
  depth: number
  /** 이 판의 앱의 줄인가 — 아니면 사슬 아래의 다른 앱의 줄이다 */
  own: boolean
  appName: string
  sessionName: string | undefined
  /** 이 줄이 세운 에이전트 세션으로 건너간다 — 세션이 남아 있을 때만 */
  onOpenSession: (() => void) | undefined
}) {
  const failed = run.status === 'error' || run.status === 'rejected'
  const when = new Date(run.createdAt)
  // 부탁의 줄은 앱이 Centralu에 부탁한 것이다 — 부른 쪽이 아니라 부탁한 앱을 적는다
  const broker = run.kind === 'broker'
  const caller = broker
    ? `Asked by ${appName}`
    : run.callerKind === 'session' && sessionName
      ? `${CALLER.session} · ${sessionName}`
      : CALLER[run.callerKind]
  const tool = !broker && !own ? `${appName} · ${run.tool}` : run.tool
  return (
    <li
      className={`border-b border-l-2 border-edge/60 py-1.5 pr-3 text-[11px] ${failed ? 'border-l-chalk' : 'border-l-transparent'}`}
      style={{ paddingLeft: 12 + depth * 14 }}
      data-testid="run-row"
      data-status={run.status}
      data-failed={failed || undefined}
      data-kind={run.kind ?? 'tool'}
      data-depth={depth}
    >
      <div className="flex items-baseline gap-2">
        {depth > 0 && (
          <span className="-ml-3 w-2 shrink-0 text-slate" aria-hidden="true">
            ↳
          </span>
        )}
        <time className="readout shrink-0 text-slate" dateTime={when.toISOString()} data-testid="run-time">
          {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </time>
        <span className="min-w-0 truncate font-mono text-chalk" data-testid="run-tool">
          {tool}
        </span>
        <span className={`readout ml-auto shrink-0 ${failed ? 'text-chalk' : 'text-slate'}`} data-testid="run-status">
          {STATUS[run.status]}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 text-slate">
        <span className="truncate" data-testid="run-caller">
          {caller}
        </span>
        {run.tokens && (
          <span className="readout shrink-0" data-testid="run-tokens" title={`in ${run.tokens.input} · out ${run.tokens.output}`}>
            {tokenCount(run.tokens.input + run.tokens.output)} tokens
          </span>
        )}
        {onOpenSession && (
          <button
            type="button"
            className="shrink-0 rounded px-1 text-[10px] text-slate underline-offset-2 transition-colors hover:text-chalk hover:underline"
            onClick={onOpenSession}
            data-testid="run-open-session"
          >
            Open session
          </button>
        )}
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
