import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { CloseIcon, PlusIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'

/**
 * 프로젝트 터미널 (여러 개).
 *
 * **터미널은 프로젝트(정확히는 디렉토리)의 것이다.** 세션의 것이 아니다.
 * 그래서 같은 프로젝트에서 세션을 바꿔도 같은 셸들이 그대로 이어진다 —
 * 돌려놓은 dev 서버나 tail이 세션을 옮길 때마다 죽으면 쓸 수가 없다.
 * (깃 워크트리 세션은 디렉토리가 다르므로 자기 터미널을 자동으로 갖는다)
 *
 * 패널이 길쭉하므로 세로로 쌓는다. 하나를 크게 보고 싶으면 패널 폭이 아니라
 * 개수를 줄이는 쪽이 맞다 — 그래서 닫기를 각 터미널에 둔다.
 */
export function TerminalPane({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const list = await platform.terminal.list(projectId)
      // 처음 열면 하나는 있어야 한다 — 빈 화면에 버튼만 있으면 한 단계가 더 든다
      if (list.length === 0) {
        setTerminals([await platform.terminal.create(projectId, 80, 24)])
        return
      }
      setTerminals(list)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [platform, projectId])

  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    try {
      const t = await platform.terminal.create(projectId, 80, 24)
      setTerminals((prev) => [...(prev ?? []), t])
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const close = async (terminalId: string) => {
    await platform.terminal.close(terminalId).catch(() => {})
    // 닫으면 번호가 다시 매겨지므로 목록을 통째로 다시 읽는다
    await load()
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="evidence-terminal">
      <div className="flex items-center gap-1.5 border-b border-edge px-3 py-1">
        <span className="text-[11px] uppercase tracking-[0.12em] text-slate">Terminal</span>
        {/* 글자를 빼고 기호만 남긴다 — 옆의 '터미널'이 이미 무엇에 대한 +인지 말해준다 */}
        <span className="ml-auto">
          <IconButton label="New terminal" onClick={() => void add()} testId="terminal-add" align="right">
            <PlusIcon size={16} />
          </IconButton>
        </span>
      </div>

      {error && (
        <p className="px-3 py-2 text-[11px] leading-relaxed text-ash" data-testid="terminal-error">
          Could not open terminal — {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col" data-testid="terminal-stack">
        {(terminals ?? []).map((t) => (
          <TerminalView key={t.terminalId} info={t} onClose={() => void close(t.terminalId)} />
        ))}
      </div>
    </section>
  )
}

/**
 * 터미널 하나.
 *
 * 화면 복원은 host의 스크롤백이 한다. 탭을 옮겼다 와도, 창을 껐다 켜도
 * 붙는 순간 지금까지의 출력을 받아 다시 그린다.
 * 컴포넌트가 사라져도 **셸은 죽이지 않는다** — 탭을 옮긴 것뿐이다.
 */
function TerminalView({ info, onClose }: { info: TerminalInfo; onClose: () => void }) {
  const platform = usePlatform()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const idRef = useRef(info.terminalId)
  /**
   * 마지막으로 셸에 알려준 크기.
   *
   * **같은 크기를 다시 보내면 안 된다.** pty resize는 SIGWINCH를 일으키고 셸은
   * 프롬프트를 다시 그린다. 그런데 fit()은 요소 레이아웃을 건드려 ResizeObserver를
   * 다시 깨우므로, 크기가 그대로여도 계속 도는 되먹임이 생긴다 —
   * 화면에는 프롬프트 줄만 끝없이 늘어나는 것으로 보인다 (도그푸딩에서 지적됨).
   */
  const lastDims = useRef({ cols: 0, rows: 0 })
  /**
   * 처음 붙을 때 한 번만 쓰는 지난 출력.
   *
   * props로 직접 읽으면 안 된다: 터미널을 하나 닫으면 목록을 다시 읽는데,
   * 그때 **살아남은 터미널들의 history도 새 스냅샷으로 바뀐다.** 그걸 의존성에 두면
   * effect가 다시 돌아 xterm이 통째로 재생성되고, 새로 만든 터미널은 기본 크기(80×24)로
   * 시작했다가 곧바로 실제 크기로 맞춰지면서 셸이 프롬프트를 다시 그린다 —
   * 닫을 때마다 줄이 늘어나는 것으로 보인다 (도그푸딩에서 두 번 지적됨).
   */
  const historyRef = useRef(info.history)
  historyRef.current = info.history
  const [dead, setDead] = useState(!info.alive)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const term = new Xterm({
      fontSize: 11,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      // 완전 무채색 규칙은 우리 화면의 것이고, 셸 출력의 색까지 뺏지는 않는다.
      // 다만 바탕과 커서는 앱에 맞춘다.
      theme: { background: '#0c0c0c', foreground: '#e9e9e9', cursor: '#e9e9e9', selectionBackground: '#2a2a2a' },
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term

    const safeFit = () => {
      try {
        fit.fit()
      } catch {
        // 아직 레이아웃이 없을 때가 있다 — 다음 기회에 맞춘다
      }
    }
    /** 크기가 **실제로 달라졌을 때만** 셸에 알린다 */
    const syncSize = () => {
      safeFit()
      const { cols, rows } = term
      if (cols < 2 || rows < 2) return
      if (cols === lastDims.current.cols && rows === lastDims.current.rows) return
      lastDims.current = { cols, rows }
      void platform.terminal.resize(idRef.current, cols, rows).catch(() => {})
    }

    safeFit()
    if (historyRef.current) term.write(historyRef.current)
    // 새 xterm은 기본 크기로 시작한다 — 이전 값과 비교하지 말고 반드시 한 번 알린다
    lastDims.current = { cols: 0, rows: 0 }
    syncSize()

    const offOutput = platform.terminal.onOutput((e) => {
      if (e.terminalId === idRef.current) term.write(e.data)
    })
    const offExit = platform.terminal.onExit((e) => {
      if (e.terminalId !== idRef.current) return
      setDead(true)
      term.write(`\r\n\x1b[2m— shell exited${e.exitCode !== null ? ` (${e.exitCode})` : ''} —\x1b[0m\r\n`)
    })
    const onData = term.onData((data) => {
      void platform.terminal.input(idRef.current, data).catch(() => {})
    })

    // 패널 폭·창 크기가 바뀌면 셸에도 알려야 줄바꿈이 깨지지 않는다.
    // 관찰 콜백은 한 프레임 뒤로 미뤄 연속 변경을 한 번으로 합친다.
    let pending = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(syncSize)
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(pending)
      ro.disconnect()
      onData.dispose()
      offOutput()
      offExit()
      term.dispose()
      termRef.current = null
    }
    // **정체성은 terminalId뿐이다.** history·title이 바뀌었다고 다시 붙지 않는다
  }, [platform, info.terminalId])

  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-b border-edge last:border-b-0"
      data-testid={`terminal-${info.terminalId}`}
    >
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <span className="readout truncate text-[10px] text-slate">{info.title}</span>
        {dead && (
          <button
            className="rounded px-1 text-[10px] text-ash transition-colors hover:text-chalk"
            data-testid={`terminal-restart-${info.terminalId}`}
            onClick={async () => {
              const term = termRef.current
              if (!term) return
              const next = await platform.terminal.restart(idRef.current, term.cols, term.rows)
              idRef.current = next.terminalId
              setDead(!next.alive)
              term.reset()
              if (next.history) term.write(next.history)
            }}
          >
            Restart
          </button>
        )}
        <span className="ml-auto">
          <IconButton
            label="Close terminal (the shell exits)"
            onClick={onClose}
            testId={`terminal-close-${info.terminalId}`}
            align="right"
          >
            <CloseIcon size={11} />
          </IconButton>
        </span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-1 pb-1" data-testid={`terminal-surface-${info.terminalId}`} />
    </div>
  )
}
