import { useCallback, useEffect, useState } from 'react'
import type { ToolName, UsageSnapshot } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore, usageTools } from '../../store/store.js'
import { useToolMeta, useTools } from '../../store/selectors.js'
import { Tooltip } from '../../components/primitives.jsx'
import { UsagePanel } from './UsagePanel.jsx'
import { usageTone, weeklyWindow } from './weekly.js'

/**
 * 상단 바의 사용량 — **도구마다 주간 도넛 하나** (사용자 요청 2026-09-09).
 *
 * 예전에는 'Usage'라는 글자 버튼 하나였고, 누르면 화면 가운데 모달이 떴다. 두 가지가
 * 아쉬웠다: ① 계기판에 숫자가 없으니 한도는 **물어봐야만** 아는 것이었고, ② 답이
 * 열리는 자리가 누른 자리에서 멀었다.
 *
 * 이제 도넛이 계기판에 상주한다 — 채운 만큼이 밝기로 보이고, 가운데에는 **그 도구의
 * 한 글자 표식**이 앉는다 (사이드바 세션 칩과 같은 글자라, 무엇의 한도인지 범례 없이
 * 읽힌다). 상세는 그 도넛 **바로 아래로** 내려온다.
 *
 * 주간만 세우는 이유: 계기판은 한 눈에 읽는 자리고, 5시간 창은 금방 회복돼 "지금 급한가"를
 * 말하지 않는다. 나머지 창은 전부 상세에 있다.
 */
export function UsageDonuts() {
  const platform = usePlatform()
  const usageOpen = useStore((s) => s.usageOpen)
  const toggleUsage = useStore((s) => s.toggleUsage)
  /**
   * host 연결 (사용자 요청 2026-09-09: "호스트가 안 뜨면 도넛 자리에 Disconnected").
   *
   * 에이전트는 host 안에서 산다 — 연결이 없으면 도구를 물어볼 방법 자체가 없다. 그래서
   * 이 한 자리가 **둘 중 하나**를 말한다: 한도(도넛)이거나, 한도를 물어볼 수 없다는 사실.
   * 빈 자리로 두면 "도구가 하나도 없다"로 읽히는데, 그건 사실이 아니라 **모르는 것**이다.
   */
  const connection = useStore((s) => s.connection)
  const offline = connection !== 'connected'
  const [snap, setSnap] = useState<Partial<Record<ToolName, { usage: UsageSnapshot | null; reason?: string }>>>({})
  const [open, setOpen] = useState<ToolName | null>(null)
  const tools = useTools()
  // 훅은 조건부로 부를 수 없다 — 닫혀 있는 동안의 값은 어차피 안 쓰인다
  const openMeta = useToolMeta(open ?? '')
  /**
   * 도넛이 서는 도구 (사용자 요청 2026-09-09: "연결된 에이전트만 도넛이 뜨는 거야").
   *
   * **없는 도구의 한도는 계기판에 자리가 없다** — 안 쓰는 도구의 빈 고리는 아무것도
   * 말하지 않으면서 눈만 쓴다. 판정은 설치+로그인(detect)이고, 그건 세션 만들기 창이
   * 쓰는 것과 같은 판정이다: 화면 두 곳이 "이 도구를 쓸 수 있나"에 다르게 답하면 안 된다.
   *
   * null은 "아직 안 물어봤다" — 그동안은 아무것도 안 그린다. 첫 답이 오기 전에 도넛을
   * 세웠다 지우면 바가 깜빡인다.
   */
  const [live, setLive] = useState<ToolName[] | null>(null)

  const load = useCallback(() => {
    // 끊긴 동안에는 묻지 않는다 — 큐에 쌓였다 30초 뒤에 실패할 뿐이다 (rpc-client의 대기 규칙)
    if (useStore.getState().connection !== 'connected') return
    void platform.agents
      .detect()
      .then((found) => setLive(found.filter((t) => t.installed && t.loggedIn).map((t) => t.name)))
      .catch(() => setLive([]))
    for (const { name: tool } of tools) {
      void platform.agents
        .usage(tool)
        .then((r) => setSnap((s) => ({ ...s, [tool]: { usage: r.usage, reason: r.supported ? undefined : r.reason } })))
        .catch((e: Error) => setSnap((s) => ({ ...s, [tool]: { usage: null, reason: e.message } })))
    }
  }, [platform, tools])

  /*
   * 뜰 때 한 번, 그 뒤로는 5분마다. 한도는 분 단위로 움직이는 값이라 초 단위 폴링은
   * 답을 바꾸지 않으면서 도구 프로세스만 두드린다 (claude는 살아 있는 세션에 묻는다).
   */
  useEffect(() => {
    load()
    const t = setInterval(load, 5 * 60_000)
    return () => clearInterval(t)
    // connection: 돌아오는 순간이 다시 물어볼 자리다 (그 사이 로그인했을 수도 있다)
  }, [load, connection])

  /*
   * 팔레트·/usage로 열면 **지금 보고 있는 도구**의 상세가 열린다 (usageTools) — 화면에
   * 그 도구가 없으면 첫 도넛. 문이 둘이어도 도착하는 곳은 하나다.
   */
  useEffect(() => {
    if (usageOpen) setOpen((cur) => cur ?? usageTools(useStore.getState())[0] ?? (live ?? [])[0] ?? null)
    else setOpen(null)
  }, [usageOpen, live])

  const show = (tool: ToolName | null) => {
    setOpen(tool)
    toggleUsage(tool !== null)
    if (tool) load()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      show(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /*
   * 끊겼으면 도넛 대신 그 사실이 선다. 숨 쉬는 점 하나와 한 단어 — 상단 바에서 가장 밝은
   * 것이 나를 막고 있는 것이라는 규칙 그대로다.
   */
  if (offline) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-beacon" data-testid="connection">
        <span className="size-1.5 rounded-full bg-beacon breathe" aria-hidden />
        {connection === 'connecting' ? 'Connecting' : 'Disconnected'}
      </span>
    )
  }

  /*
   * host는 붙었는데 쓸 수 있는 도구가 하나도 없다 — 빈 자리로 두면 "볼 게 없다"로 읽히지만
   * 실은 **할 일이 있는 상태**다(설치 또는 로그인). 끊김과 같은 규칙으로 그 사실을 적는다.
   * 아직 안 물어봤을 때(null)는 아무 말도 안 한다 — 첫 답 전의 침묵은 사실이 아니다.
   */
  if (live !== null && live.length === 0) {
    return (
      <Tooltip
        testId="usage-no-agent-tip"
        content={
          <span className="block">
            <span className="block text-chalk">No agent connected</span>
            <span className="mt-1 block text-slate">Install or sign in to Claude Code or Codex</span>
          </span>
        }
      >
        <span className="text-[11px] text-ash" data-testid="usage-no-agent">
          No agent
        </span>
      </Tooltip>
    )
  }

  return (
    <span className="relative flex items-center gap-0.5" data-testid="usage-donuts">
      {(live ?? []).map((tool) => (
        <Donut
          key={tool}
          tool={tool}
          snap={snap[tool]}
          active={open === tool}
          onClick={() => show(open === tool ? null : tool)}
        />
      ))}

      {open && (
        <>
          {/* 바깥을 누르면 닫힌다 — 화면을 덮되 어둡히지 않는다 (인박스와 같은 규칙) */}
          <div className="fixed inset-0 z-30" onClick={() => show(null)} data-testid="usage-backdrop" />
          <div
            className="cc-drop absolute right-0 top-full z-40 mt-1 w-[420px] max-w-[calc(92vw/var(--text-zoom))] overflow-hidden rounded-lg border border-edge bg-pit shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
            data-testid="usage-drop"
          >
            <header className="flex items-center gap-2 border-b border-edge px-4 py-2">
              <h2 className="text-[13px] font-medium text-chalk">Usage</h2>
              <span className="readout text-[11px] text-slate">{openMeta.label}</span>
            </header>
            <div className="max-h-[calc(60vh/var(--text-zoom))] overflow-y-auto">
              <UsagePanel tool={open} />
            </div>
          </div>
        </>
      )}
    </span>
  )
}

/**
 * 도넛 하나 — 고리는 주간 사용량, 가운데는 도구의 한 글자.
 *
 * 숫자를 모를 때 **꽉 찬 회색 고리를 그리지 않는다**: 그건 "0% 썼다"로 읽힌다.
 * 점선 고리는 모른다는 뜻이고, 왜 모르는지는 눌러서 여는 상세가 답한다
 * (claude는 살아 있는 세션이 있어야 한도를 물을 수 있다 — 흔한 '모름'의 이유다).
 */
function Donut({
  tool,
  snap,
  active,
  onClick,
}: {
  tool: ToolName
  snap?: { usage: UsageSnapshot | null; reason?: string }
  active: boolean
  onClick: () => void
}) {
  const meta = useToolMeta(tool)
  const w = snap?.usage ? weeklyWindow(snap.usage.windows) : null
  const known = w !== null
  const percent = w?.percent ?? 0
  const R = 9
  const C = 2 * Math.PI * R
  const filled = (Math.max(0, Math.min(100, percent)) / 100) * C
  const tone = known ? usageTone(percent) : 'text-slate'

  return (
    <Tooltip
      testId={`usage-donut-tip-${tool}`}
      content={
        <span className="block">
          <span className="block text-chalk">{meta.label}</span>
          <span className="readout mt-1 block">
            {known ? `${w.label}${w.scope ? ` · ${w.scope}` : ''} — ${percent}% used` : 'Weekly usage unknown'}
          </span>
        </span>
      }
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={`${meta.label} weekly usage${known ? ` ${percent}%` : ' unknown'}`}
        data-testid={`usage-donut-${tool}`}
        data-percent={known ? percent : ''}
        /*
         * 열려 있는 동안에도 **다른 도넛을 바로 누를 수 있어야 한다** — 바깥 클릭 막이
         * 도넛까지 덮으면 도구를 바꾸는 데 두 번 눌러야 한다. 그래서 막보다 위에 선다.
         */
        /*
         * 하이라이트도 **동그랗다** (사용자 지적 2026-09-10). 고리를 가리키는 자리에
         * 네모가 켜지면 손이 닿은 것이 도넛인지 그 뒤의 칸인지가 어긋나 보인다 —
         * 밝아지는 모양은 그 버튼의 모양이어야 한다.
         */
        className={`relative z-40 flex items-center rounded-full p-0.5 transition-colors hover:bg-graphite/50 ${
          active ? 'bg-graphite/50' : ''
        }`}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
          <circle
            cx="12"
            cy="12"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="text-edge"
            {...(known ? {} : { strokeDasharray: '2 3' })}
          />
          {known && (
            <circle
              cx="12"
              cy="12"
              r={R}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${filled} ${C - filled}`}
              // 12시에서 시작해야 사람이 읽는 방향과 맞는다 (상세의 큰 도넛과 같은 규칙)
              transform="rotate(-90 12 12)"
              className={tone}
            />
          )}
          {/*
            가운데 글자 = 사이드바 세션 칩과 **같은 표식**. 도넛이 둘 서 있을 때 어느
            것이 무엇인지 범례 없이 읽히는 이유가 이 한 글자다.
          */}
          <text
            x="12"
            y="12"
            textAnchor="middle"
            dominantBaseline="central"
            className={`fill-current font-mono ${known ? 'text-chalk' : 'text-slate'}`}
            style={{ fontSize: '9px' }}
          >
            {meta.mark}
          </text>
        </svg>
      </button>
    </Tooltip>
  )
}
