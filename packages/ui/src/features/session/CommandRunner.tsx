import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SavedCommand } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { useOpenLayer } from '../../components/Modal.jsx'
import { isPlainEnter } from './composerKeys.js'
import { registerTerminalHttpLinks } from '../../components/terminalLinks.js'
import { useStore } from '../../store/store.js'

const NO_COMMANDS: SavedCommand[] = []
const NO_RUNS: Record<string, never> = {}

/**
 * 자주 쓰는 명령어 (#60) — 터미널 탭과 별개의 실행 창.
 *
 * 예전에는 헤더의 작은 팝오버에서 고르면 **터미널 탭의 PTY에 타이핑**해 넣었다.
 * 그러면 단발성 빌드도 데브 서버도 전부 터미널 탭에 눌러앉았고, 좁은 팝오버로는
 * 로그를 볼 자리도 없었다. 한동안 칸을 통째로 덮는 창이었는데, 목록 몇 줄에
 * 화면 전부는 과했다(사용자 지적 2026-09-06) — 지금은 가운데 뜨는 작은 창이고,
 * 로그는 명령을 골랐을 때만 아래로 열린다.
 *
 * 별칭(label)은 같은 날의 요청이다: `pnpm dev`보다 "데브 서버"가 한눈에 읽힌다.
 * 단, 이름이 몰래 딴 명령을 뜻하게 되는 표류를 막는 규칙 하나 — **별칭을 보여주는
 * 모든 자리는 명령도 같이 보여준다.** 정체성은 어디까지나 명령 문자열이다.
 *
 * 단발/상주를 **구분하지 않는다** — 안 끝나면 로그가 계속 흐르고, 끝나면 종료
 * 코드와 함께 로그가 남는 것뿐이다. 데브 서버는 그냥 안 끝나는 명령이다.
 * 로그는 명령별 마지막 실행 하나가 host에 남는다(앱 수명 동안) — 창을 닫았다
 * 열어도, 같은 명령을 **다시 실행하기 전까지** 그대로다 (사용자 결정 2026-08-26).
 *
 * 실행 상태는 이 창의 것이 아니라 스토어 장부(commandRuns)의 것이다 — 창을 닫아도
 * **돌고 있는 명령은 터미널 패널에 터미널로 서 있고**, 종료는 어디서 났든 장부를
 * 거쳐 양쪽에 같이 비친다. 창은 등록·실행·지난 로그의 정본이고, 패널은 사는 곳이다.
 */
export function CommandRunnerOverlay({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const commands = useStore((s) => s.projects[projectId]?.commands ?? NO_COMMANDS)
  const save = useStore((s) => s.setProjectCommands)
  const runCommand = useStore((s) => s.runCommand)
  const stopCommand = useStore((s) => s.stopCommand)
  const [selected, setSelected] = useState<string | null>(null)
  /** 명령 → 마지막 실행 상태 (뱃지용). 로그 본문은 LogView가 따로 든다 */
  const runs = useStore((s) => s.commandRuns[projectId] ?? NO_RUNS)
  const [draft, setDraft] = useState('')
  const [draftName, setDraftName] = useState('')
  /** 별칭을 고치는 중인 명령 (명령 문자열이 키다) */
  const [renaming, setRenaming] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 닫힘 애니메이션 중 — 내려온 길로 도로 올라간 뒤에야 onClose로 unmount한다 */
  const [leaving, setLeaving] = useState(false)
  const leave = useCallback(() => setLeaving(true), [])
  // 칸을 덮는 층이다 — 떠 있는 동안 그 아래 승인 카드가 y/n/a를 받지 않는다 (#158)
  useOpenLayer()

  // reduced-motion이면 animationend가 안 온다 — 타이머가 unmount를 보증한다 (설정 메뉴와 같은 규칙)
  useEffect(() => {
    if (!leaving) return
    const t = window.setTimeout(onClose, 200)
    return () => window.clearTimeout(t)
  }, [leaving, onClose])

  // 열 때 host의 실행 장부를 읽는다 — 창을 닫아도 실행은 계속되므로 다시 열면 이어 보인다.
  // (그리드에는 증거 패널이 없어서 여기서도 읽어야 한다 — UI 리로드 직후의 그리드 경로)
  useEffect(() => {
    void useStore.getState().loadCommandRuns(projectId)
  }, [projectId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      // 별칭 입력 중이면 Esc는 입력 취소다 — 창까지 닫으면 두 단계가 한 번에 무너진다
      if (renaming !== null) setRenaming(null)
      else leave()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [leave, renaming])

  // 실행·정지는 스토어 장부를 거친다 — 터미널 패널·탭 뱃지가 같은 사실을 본다 (실패 토스트도 거기서)
  const run = (command: string) => void runCommand(projectId, command)
  const stop = (command: string) => void stopCommand(projectId, command)

  const add = () => {
    const command = draft.trim()
    if (!command) return
    const label = draftName.trim()
    setDraft('')
    setDraftName('')
    void save(projectId, [...commands, { command, ...(label ? { label } : {}) }])
  }

  const rename = (command: string, label: string) => {
    setRenaming(null)
    const clean = label.trim()
    void save(
      projectId,
      commands.map((c) => (c.command === command ? { command, ...(clean ? { label: clean } : {}) } : c)),
    )
  }

  const sel = selected ? commands.find((c) => c.command === selected) : undefined
  const current = sel?.command ?? null
  const currentRun = current ? runs[current] : undefined

  return (
    /* 바깥 여백을 누르면 닫힌다 — 창 자체(mousedown이 안쪽에서 시작)는 무시 */
    <div
      ref={rootRef}
      className="absolute inset-0 z-40 flex items-start justify-end bg-void/40 px-2 pb-4 pt-8"
      data-testid="run-menu"
      onMouseDown={(e) => {
        if (e.target === rootRef.current) leave()
      }}
    >
      {/*
        헤더의 ▶ 아래에 드롭다운으로 붙는다 (사용자 요청 2026-09-06 — 가운데 모달은
        목록 몇 줄에 과한 무게였다). 위에서 내려오는 cc-drop이 출처를 말해 준다.
        창은 내용만큼만 서고, 로그를 열면 아래로 자란다.
      */}
      <div
        onAnimationEnd={() => leaving && onClose()}
        className={`flex max-h-full w-[min(560px,100%)] flex-col overflow-hidden rounded border border-edge bg-panel shadow-[0_16px_48px_-8px_rgb(0_0_0/0.9)] ${
          leaving ? 'cc-drop-out pointer-events-none' : 'cc-drop'
        }`}
      >
        <div className="flex items-center gap-1.5 border-b border-edge px-3 py-1.5">
          <span className="text-[11px] uppercase text-slate">Commands</span>
          <span className="ml-auto">
            <IconButton label="Close" onClick={leave} testId="run-close" align="right">
              <CloseIcon size={12} />
            </IconButton>
          </span>
        </div>

        {/*
          명령 목록.

          줄마다 테두리를 두르지 않는다. 예전엔 줄이 `border-edge bg-void` 상자였는데,
          바로 아래 등록 칸의 입력이 똑같은 껍데기라 **목록이 빈 입력 칸처럼 보였다**
          (사용자 지적 2026-09-07). 그렇다고 아무 바탕도 안 주면 이번엔 창 바탕과 붙어
          목록이 어디서 시작하는지 안 보인다 (같은 날 두 번째 지적).

          그래서 **줄이 아니라 목록 전체가 한 칸**이다: 창보다 한 단 어두운 바닥(bg-void)
          위에 머리카락 선으로 줄을 가른다. 테두리 있는 상자는 여전히 글자를 넣는 곳뿐이고,
          목록은 눌러앉은 판이라 입력과 헷갈릴 여지가 없다.
        */}
        <div className="max-h-64 shrink-0 overflow-y-auto border-b border-edge bg-void">
          {commands.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-slate">
              No saved commands yet — add one below. It runs in the project folder.
            </p>
          )}
          {commands.map((c, i) => {
            const r = runs[c.command]
            return (
              <div
                key={`${i}-${c.command}`}
                className={`group/row flex items-center border-b border-edge/60 transition-colors last:border-b-0 ${
                  current === c.command ? 'bg-graphite/50' : 'hover:bg-graphite/25'
                }`}
              >
                <button
                  type="button"
                  data-testid={`run-command-${i}`}
                  onClick={() => setSelected(c.command)}
                  className="min-w-0 flex-1 px-3 py-1.5 text-left"
                >
                  {renaming === c.command ? (
                    <input
                      autoFocus
                      defaultValue={c.label ?? ''}
                      placeholder="Name (blank removes it)"
                      data-testid={`run-rename-input-${i}`}
                      className="w-full rounded border border-edge bg-panel px-1 py-0.5 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        // 조합을 끝내는 Enter는 저장이 아니다 (#181) — 한글 별칭의 마지막 음절이 빠졌다
                        if (isPlainEnter({ key: e.key, isComposing: e.nativeEvent.isComposing }))
                          rename(c.command, (e.target as HTMLInputElement).value)
                        // Esc는 위의 창 리스너가 renaming만 걷는다
                      }}
                      onBlur={(e) => renaming === c.command && rename(c.command, e.target.value)}
                    />
                  ) : c.label ? (
                    <>
                      <span className="block truncate text-[12px] text-chalk">{c.label}</span>
                      <span className="readout block truncate text-[10px] text-slate">{c.command}</span>
                    </>
                  ) : (
                    <span className="readout block truncate py-0.5 text-[12px] text-ash transition-colors group-hover/row:text-chalk">
                      {c.command}
                    </span>
                  )}
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
                {/* 별칭 달기/고치기 — hover에만 (매 줄의 상설 버튼 셋은 목록을 시끄럽게 한다) */}
                <button
                  type="button"
                  data-testid={`run-rename-${i}`}
                  aria-label={`Rename ${c.command}`}
                  onClick={() => setRenaming(c.command)}
                  className="shrink-0 px-1.5 py-1.5 text-[10px] text-slate opacity-0 transition-opacity hover:text-chalk focus:opacity-100 group-hover/row:opacity-100"
                >
                  {c.label ? 'Rename' : 'Name'}
                </button>
                {/* 지우기는 실행과 다른 과녁 — 잘못 눌러 되돌릴 수 없는 쪽에 간격을 준다 */}
                <button
                  type="button"
                  data-testid={`run-delete-${i}`}
                  aria-label={`Remove ${c.command}`}
                  onClick={() => {
                    if (current === c.command) setSelected(null)
                    void save(projectId, commands.filter((_, j) => j !== i))
                  }}
                  className="shrink-0 rounded-r px-2 py-1.5 text-slate transition-colors hover:bg-graphite/70 hover:text-chalk"
                >
                  <CloseIcon size={10} />
                </button>
              </div>
            )
          })}
        </div>

        {/* 등록 — 목록의 마지막 줄이 아니라 바닥의 한 칸이다. 판이 끝나는 자리가 곧 경계다 */}
        <div className="shrink-0 p-2">
          <div className="flex items-center gap-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isPlainEnter({ key: e.key, isComposing: e.nativeEvent.isComposing })) add()
              }}
              placeholder="Command, e.g. pnpm dev"
              data-testid="run-add-input"
              className="readout min-w-0 flex-1 rounded border border-edge bg-void px-2 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
            />
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (isPlainEnter({ key: e.key, isComposing: e.nativeEvent.isComposing })) add()
              }}
              placeholder="Name (optional)"
              data-testid="run-add-name"
              className="w-32 shrink-0 rounded border border-edge bg-void px-2 py-1.5 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
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

        {/* 실행·정지·로그 — 명령을 골랐을 때만. 안 골랐으면 창은 목록만큼만 작다 */}
        {current && (
          <>
            <div className="flex items-center gap-2 border-y border-edge px-3 py-1.5">
              <button
                type="button"
                data-testid="run-exec"
                onClick={() => void run(current)}
                className="rounded border border-edge px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite hover:bg-graphite/25"
              >
                {currentRun?.running ? 'Restart' : 'Run'}
              </button>
              {currentRun?.running && (
                <button
                  type="button"
                  data-testid="run-stop"
                  onClick={() => void stop(current)}
                  className="rounded border border-edge px-3 py-1 text-[12px] text-ash transition-colors hover:border-graphite hover:text-chalk"
                >
                  Stop
                </button>
              )}
              <span className="readout min-w-0 truncate text-[11px] text-slate" data-testid="run-selected">
                {sel?.label ? `${sel.label} · ${current}` : current}
              </span>
            </div>

            {/* 선택한 명령의 로그 — runId가 바뀌면(재실행) 처음부터 다시 그린다 */}
            <div className="h-64 min-h-0 shrink" data-testid="run-log">
              {currentRun ? (
                <LogView key={currentRun.runId} projectId={projectId} command={current} runId={currentRun.runId} />
              ) : (
                <p className="px-3 py-2 text-[11px] text-slate">Not run yet — press Run.</p>
              )}
            </div>
          </>
        )}
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

  return <div ref={hostRef} className="h-full px-1 py-1" data-testid={`run-log-surface-${runId}`} />
}
