import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { CommandRunInfo, TerminalInfo } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { CloseIcon, PlusIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { registerTerminalHttpLinks } from '../../components/terminalLinks.js'
import { useStore } from '../../store/store.js'
import { TabActions } from './tabActions.jsx'

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
  /*
   * 실행 중인 자주 쓰는 명령 (#60, 사용자 결정 2026-09-06) — **도는 동안만** 터미널
   * 하나로 선다. 어떤 이유로든 끝나면(정상·크래시·Stop) 그 터미널은 내려간다:
   * 장부의 running이 꺼지는 순간이 곧 철거다. 지난 로그는 실행 창(CommandRunner)이
   * 정본으로 들고 있다 — 여기는 "지금 돌고 있는 것"의 자리다.
   * 레코드 참조를 그대로 골라야 한다 — 셀렉터가 매번 새 배열을 만들면 무한 리렌더다.
   */
  const cmdRuns = useStore((s) => s.commandRuns[projectId])
  const runningCmds = Object.values(cmdRuns ?? {})
    .filter((r) => r.running)
    .sort((a, b) => a.startedAt - b.startedAt)

  /*
   * 요청 세대 번호. 목록을 기다리는 사이 프로젝트를 바꾸면 늦은 응답이
   * **다른 프로젝트의 터미널**을 그리고, 빈 목록이었다면 옛 프로젝트에
   * 터미널을 하나 만들어 버린다 — 마지막 요청만 화면을 쓸 수 있게 한다.
   */
  const loadGen = useRef(0)
  const load = useCallback(async () => {
    const gen = ++loadGen.current
    try {
      const list = await platform.terminal.list(projectId)
      if (gen !== loadGen.current) return
      // 처음 열면 하나는 있어야 한다 — 빈 화면에 버튼만 있으면 한 단계가 더 든다
      if (list.length === 0) {
        const t = await platform.terminal.create(projectId, 80, 24)
        if (gen !== loadGen.current) return
        setTerminals([t])
        return
      }
      setTerminals(list)
    } catch (e) {
      if (gen === loadGen.current) setError((e as Error).message)
    }
  }, [platform, projectId])

  useEffect(() => {
    // 프로젝트가 바뀌었다 — 옛 프로젝트의 셸을 그대로 보여주면 안 된다
    setTerminals(null)
    setError(null)
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
      {/*
        머리띠를 따로 두지 않는다 (사용자 요청 2026-09-07). 이름표 'Terminal'은 바로 위
        탭이 이미 하고 있는 말이었고, 띠 두 줄은 좁은 패널에서 내용이 시작하는 자리를
        그만큼 밀어냈다. 버튼은 탭 띠의 오른쪽 끝으로 간다 — 포털이라 상태는 여기 그대로다.
      */}
      <TabActions>
        <IconButton label="New terminal" onClick={() => void add()} testId="terminal-add" align="right">
          <PlusIcon size={16} />
        </IconButton>
      </TabActions>

      {error && (
        <p className="px-3 py-2 text-[11px] leading-relaxed text-ash" data-testid="terminal-error">
          Could not open terminal — {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col" data-testid="terminal-stack">
        {/* 명령 터미널이 위 — 방금 실행한 것이 스크롤 없이 보여야 한다. 셸은 늘 그 아래 산다 */}
        {runningCmds.map((r) => (
          <CommandTerminal key={r.runId} projectId={projectId} run={r} />
        ))}
        {/*
          닫을 id는 TerminalView가 넘겨준다 — 재시작하면 host가 **새 id**를 발급하는데,
          목록의 t.terminalId로 닫으면 죽은 옛 id를 닫아서 닫기가 영영 안 먹었다.
        */}
        {(terminals ?? []).map((t) => (
          <TerminalView key={t.terminalId} info={t} onClose={(id) => void close(id)} />
        ))}
      </div>
    </section>
  )
}

/**
 * 실행 중인 명령 하나 — 셸 터미널과 나란히 서는 칸 (#60 최종 형태).
 *
 * ×는 닫기가 아니라 **정지**다: 이 칸은 실행이 있는 동안만 존재하므로 둘은 같은
 * 뜻이다. Stop의 결말도 exit 이벤트로 돌아와 장부가 꺼지고, 그 순간 칸이 내려간다.
 */
function CommandTerminal({ projectId, run }: { projectId: string; run: CommandRunInfo }) {
  const stopCommand = useStore((s) => s.stopCommand)
  // 별칭 규칙 (2026-09-06): 이름을 보여주는 자리는 명령도 같이 보여준다 — 이름은 표류할 수 있다
  const label = useStore((s) => s.projects[projectId]?.commands.find((c) => c.command === run.command)?.label)
  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-b border-edge last:border-b-0"
      data-testid={`cmd-term-${run.command}`}
    >
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-chalk" aria-label="running" />
        {label && <span className="truncate text-[10px] text-ash">{label}</span>}
        <span className="readout truncate text-[10px] text-slate" title={run.command}>
          {run.command}
        </span>
        <span className="ml-auto">
          <IconButton
            label="Stop the command (the log stays in the run window)"
            onClick={() => void stopCommand(projectId, run.command)}
            testId={`cmd-term-stop-${run.command}`}
            align="right"
          >
            <CloseIcon size={11} />
          </IconButton>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <CommandLog projectId={projectId} command={run.command} runId={run.runId} />
      </div>
    </div>
  )
}

/**
 * 명령 로그 하나 (읽기 전용 xterm — 색을 살리는 가장 싼 길이 터미널 에뮬레이터다).
 * 화면 복원은 host의 로그 버퍼가 한다: 붙는 순간 지금까지의 출력을 통째로 받고,
 * 그 뒤는 터미널과 같은 스트림(runId가 terminalId 자리)을 듣는다.
 */
function CommandLog({ projectId, command, runId }: { projectId: string; command: string; runId: string }) {
  const platform = usePlatform()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const term = new Xterm({
      fontSize: 11,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      theme: { background: '#1d1d1d', foreground: '#e9e9e9', cursor: '#1d1d1d', selectionBackground: '#353535' },
      disableStdin: true,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    const links = registerTerminalHttpLinks(term, (url) => {
      void platform.system
        .openUrl(url)
        .catch((e) => useStore.getState().setToast(`Could not open ${url}: ${(e as Error).message}`))
    })

    const lastDims = { cols: 0, rows: 0 }
    const syncSize = () => {
      try {
        fit.fit()
      } catch {
        // 아직 레이아웃이 없을 때가 있다 — 다음 기회에 맞춘다
      }
      const { cols, rows } = term
      if (cols < 2 || rows < 2) return
      if (cols === lastDims.cols && rows === lastDims.rows) return
      lastDims.cols = cols
      lastDims.rows = rows
      void platform.commands.resize(projectId, command, cols, rows).catch(() => {})
    }
    syncSize()

    // 지금까지의 로그를 통째로 — 그 뒤의 조각과 순서가 어긋나지 않게 스트림 구독을 먼저 건다
    const pendingChunks: string[] = []
    let replayed = false
    const offOutput = platform.terminal.onOutput((e) => {
      if (e.terminalId !== runId) return
      if (replayed) term.write(e.data)
      else pendingChunks.push(e.data)
    })
    const offExit = platform.terminal.onExit((e) => {
      if (e.terminalId !== runId) return
      term.write(`\r\n\x1b[2m— exited${e.exitCode !== null ? ` (${e.exitCode})` : ''} —\x1b[0m\r\n`)
    })
    void platform.commands
      .log(projectId, command)
      .then((run) => {
        // 재실행으로 다른 runId가 됐다면 이 뷰는 곧 교체된다 — 옛 로그를 그리지 않는다
        if (!run || run.runId !== runId) return
        term.write(run.history)
        for (const chunk of pendingChunks.splice(0)) term.write(chunk)
        replayed = true
        if (!run.running && run.exitCode !== null) {
          term.write(`\r\n\x1b[2m— exited (${run.exitCode}) —\x1b[0m\r\n`)
        }
      })
      .catch(() => {})

    let pending = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(syncSize)
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(pending)
      ro.disconnect()
      offOutput()
      offExit()
      links.dispose()
      term.dispose()
    }
  }, [platform, projectId, command, runId])

  return <div ref={hostRef} className="h-full px-1 py-1" data-testid={`cmd-log-surface-${runId}`} />
}

/**
 * 터미널 하나.
 *
 * 화면 복원은 host의 스크롤백이 한다. 탭을 옮겼다 와도, 창을 껐다 켜도
 * 붙는 순간 지금까지의 출력을 받아 다시 그린다.
 * 컴포넌트가 사라져도 **셸은 죽이지 않는다** — 탭을 옮긴 것뿐이다.
 */
function TerminalView({ info, onClose }: { info: TerminalInfo; onClose: (terminalId: string) => void }) {
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
      theme: { background: '#171717', foreground: '#e9e9e9', cursor: '#e9e9e9', selectionBackground: '#353535' },
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    const links = registerTerminalHttpLinks(term, (url) => {
      void platform.system
        .openUrl(url)
        .catch((e) => useStore.getState().setToast(`Could not open ${url}: ${(e as Error).message}`))
    })
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
      links.dispose()
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
            // props의 id가 아니라 **지금의** id — 재시작을 거쳤으면 둘이 다르다
            onClick={() => onClose(idRef.current)}
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
