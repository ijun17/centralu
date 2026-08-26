import { useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { CommandRunInfo } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { useStore } from '../../store/store.js'

const NO_COMMANDS: string[] = []

/**
 * 자주 쓰는 명령어 (#60) — 터미널 탭과 별개의 실행 창.
 *
 * 예전에는 헤더의 작은 팝오버에서 고르면 **터미널 탭의 PTY에 타이핑**해 넣었다.
 * 그러면 단발성 빌드도 데브 서버도 전부 터미널 탭에 눌러앉았고, 좁은 팝오버로는
 * 로그를 볼 자리도 없었다. 이 창은 세션 칸 안에 넓게 뜬다: 위에 명령 목록,
 * 아래에 선택한 명령의 로그.
 *
 * 단발/상주를 **구분하지 않는다** — 안 끝나면 로그가 계속 흐르고, 끝나면 종료
 * 코드와 함께 로그가 남는 것뿐이다. 데브 서버는 그냥 안 끝나는 명령이다.
 * 로그는 명령별 마지막 실행 하나가 host에 남는다(앱 수명 동안) — 창을 닫았다
 * 열어도, 같은 명령을 **다시 실행하기 전까지** 그대로다 (사용자 결정 2026-08-26).
 */
export function CommandRunnerOverlay({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const commands = useStore((s) => s.projects[projectId]?.commands ?? NO_COMMANDS)
  const save = useStore((s) => s.setProjectCommands)
  const [selected, setSelected] = useState<string | null>(null)
  /** 명령 → 마지막 실행 상태 (뱃지용). 로그 본문은 LogView가 따로 든다 */
  const [runs, setRuns] = useState<Record<string, CommandRunInfo>>({})
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  // 열 때 host의 실행 상태를 읽는다 — 창을 닫아도 실행은 계속되므로 다시 열면 이어 보인다
  useEffect(() => {
    let alive = true
    void platform.commands
      .state(projectId)
      .then((rs) => {
        if (alive) setRuns(Object.fromEntries(rs.map((r) => [r.command, r])))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [platform, projectId])

  // 종료를 목록 뱃지에도 반영한다 (로그 쪽은 LogView가 같은 스트림으로 듣는다)
  useEffect(
    () =>
      platform.terminal.onExit((e) => {
        setRuns((prev) => {
          const cmd = Object.keys(prev).find((c) => prev[c]!.runId === e.terminalId)
          if (!cmd) return prev
          return { ...prev, [cmd]: { ...prev[cmd]!, running: false, exitCode: e.exitCode } }
        })
      }),
    [platform],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const run = async (command: string) => {
    try {
      const info = await platform.commands.run(projectId, command, 100, 30)
      setRuns((prev) => ({ ...prev, [command]: info }))
    } catch (e) {
      useStore.setState({ toast: `Could not run: ${(e as Error).message}` })
    }
  }

  const stop = async (command: string) => {
    await platform.commands.stop(projectId, command).catch(() => {})
  }

  const add = () => {
    const next = draft.trim()
    if (!next) return
    setDraft('')
    void save(projectId, [...commands, next])
  }

  const current = selected && commands.includes(selected) ? selected : null
  const currentRun = current ? runs[current] : undefined

  return (
    /* 바깥 여백을 누르면 닫힌다 — 창 자체(mousedown이 안쪽에서 시작)는 무시 */
    <div
      ref={rootRef}
      className="absolute inset-0 z-40 bg-void/70 p-4"
      data-testid="run-menu"
      onMouseDown={(e) => {
        if (e.target === rootRef.current) onClose()
      }}
    >
      <div className="flex h-full w-full flex-col overflow-hidden rounded border border-edge bg-panel shadow-[0_16px_48px_-8px_rgb(0_0_0/0.9)]">
        <div className="flex items-center gap-1.5 border-b border-edge px-3 py-1.5">
          <span className="text-[11px] uppercase tracking-[0.12em] text-slate">Commands</span>
          <span className="ml-auto">
            <IconButton label="Close" onClick={onClose} testId="run-close" align="right">
              <CloseIcon size={12} />
            </IconButton>
          </span>
        </div>

        {/* 명령 목록 — 각 줄이 상자다 (RunMenu에서 배운 것: 셸 명령은 줄 구분이 곧 가독성) */}
        <div className="flex max-h-[40%] flex-col gap-1 overflow-y-auto p-2">
          {commands.map((c, i) => {
            const r = runs[c]
            return (
              <div
                key={`${i}-${c}`}
                className={`flex items-center rounded border bg-void transition-colors ${
                  current === c ? 'border-ash/60' : 'border-edge hover:border-graphite'
                }`}
              >
                <button
                  type="button"
                  data-testid={`run-command-${i}`}
                  onClick={() => setSelected(c)}
                  className="readout min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[12px] text-ash transition-colors hover:text-chalk"
                >
                  {c}
                </button>
                {/* 상태는 목록에서도 보인다 — 창을 열자마자 "어느 게 돌고 있나"가 읽혀야 한다 */}
                {r?.running && (
                  <span
                    className="mr-1 size-1.5 shrink-0 animate-pulse rounded-full bg-chalk"
                    data-testid={`run-running-${i}`}
                    aria-label="running"
                  />
                )}
                {r && !r.running && (
                  <span className="readout mr-1 shrink-0 text-[10px] text-slate" data-testid={`run-exit-${i}`}>
                    exit {r.exitCode ?? '?'}
                  </span>
                )}
                {/* 지우기는 실행과 다른 과녁 — 잘못 눌러 되돌릴 수 없는 쪽에 간격을 준다 */}
                <button
                  type="button"
                  data-testid={`run-delete-${i}`}
                  aria-label={`Remove ${c}`}
                  onClick={() => {
                    if (current === c) setSelected(null)
                    void save(projectId, commands.filter((_, j) => j !== i))
                  }}
                  className="shrink-0 rounded-r px-2 py-1.5 text-slate transition-colors hover:bg-graphite/25 hover:text-chalk"
                >
                  <CloseIcon size={10} />
                </button>
              </div>
            )
          })}
          {/* 등록 — 마지막 줄은 언제나 하나 더 추가하는 줄 (쓰고 싶은 순간이 곧 등록하는 순간) */}
          <div className="flex items-center gap-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add()
              }}
              placeholder="Add a command (runs in the project directory)"
              data-testid="run-add-input"
              className="readout min-w-0 flex-1 rounded border border-edge bg-void px-2 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
            />
            <button
              type="button"
              data-testid="run-add"
              onClick={add}
              className="shrink-0 rounded border border-edge px-2 py-1.5 text-[11px] text-ash transition-colors hover:border-graphite hover:text-chalk"
            >
              Add
            </button>
          </div>
        </div>

        {/* 실행·정지 — 목록과 로그 사이. 선택이 없으면 눌러도 갈 곳이 없으니 잠근다 */}
        <div className="flex items-center gap-2 border-y border-edge px-3 py-1.5">
          <button
            type="button"
            data-testid="run-exec"
            disabled={!current}
            onClick={() => current && void run(current)}
            className="rounded border border-edge px-3 py-1 text-[12px] text-chalk transition-colors enabled:hover:border-graphite enabled:hover:bg-graphite/25 disabled:opacity-40"
          >
            {currentRun?.running ? 'Restart' : 'Run'}
          </button>
          {currentRun?.running && (
            <button
              type="button"
              data-testid="run-stop"
              onClick={() => current && void stop(current)}
              className="rounded border border-edge px-3 py-1 text-[12px] text-ash transition-colors hover:border-graphite hover:text-chalk"
            >
              Stop
            </button>
          )}
          {current && (
            <span className="readout min-w-0 truncate text-[11px] text-slate" data-testid="run-selected">
              {current}
            </span>
          )}
        </div>

        {/* 선택한 명령의 로그 — runId가 바뀌면(재실행) 처음부터 다시 그린다 */}
        <div className="min-h-0 flex-1" data-testid="run-log">
          {current && currentRun ? (
            <LogView key={currentRun.runId} projectId={projectId} command={current} runId={currentRun.runId} />
          ) : (
            <p className="px-3 py-2 text-[11px] text-slate">
              {current ? 'Not run yet — press Run.' : 'Pick a command to see its last run.'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 로그 하나 (읽기 전용 xterm — 색을 살리는 가장 싼 길이 터미널 에뮬레이터다).
 * 화면 복원은 host의 로그 버퍼가 한다: 붙는 순간 지금까지의 출력을 통째로 받고,
 * 그 뒤는 터미널과 같은 스트림(runId가 terminalId 자리)을 듣는다.
 */
function LogView({ projectId, command, runId }: { projectId: string; command: string; runId: string }) {
  const platform = usePlatform()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const term = new Xterm({
      fontSize: 11,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      theme: { background: '#121212', foreground: '#e9e9e9', cursor: '#121212', selectionBackground: '#2a2a2a' },
      disableStdin: true,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

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
      term.dispose()
    }
  }, [platform, projectId, command, runId])

  return <div ref={hostRef} className="h-full px-1 py-1" data-testid={`run-log-surface-${runId}`} />
}
