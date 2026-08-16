import { useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

/**
 * 프로젝트 터미널.
 *
 * **터미널은 프로젝트(정확히는 디렉토리)의 것이다.** 세션의 것이 아니다.
 * 그래서 같은 프로젝트에서 세션을 바꿔도 같은 셸이 그대로 이어진다 —
 * 돌려놓은 dev 서버나 tail이 세션을 옮길 때마다 죽으면 쓸 수가 없다.
 * (깃 워크트리 세션은 디렉토리가 다르므로 자기 터미널을 자동으로 갖는다)
 *
 * 화면 복원은 host의 스크롤백이 한다. 탭을 옮겼다 와도, 창을 껐다 켜도
 * 붙는 순간 지금까지의 출력을 통째로 받아 다시 그린다.
 */
export function Terminal({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const idRef = useRef<string | null>(null)
  const [dead, setDead] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 패널 폭이 바뀌면 열 수를 다시 맞춰야 한다
  const width = useStore((s) => s.panelWidth)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let disposed = false

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
    safeFit()

    const offOutput = platform.terminal.onOutput((e) => {
      if (e.terminalId === idRef.current) term.write(e.data)
    })
    const offExit = platform.terminal.onExit((e) => {
      if (e.terminalId !== idRef.current) return
      setDead(true)
      term.write(`\r\n\x1b[2m— 셸이 종료되었습니다${e.exitCode !== null ? ` (${e.exitCode})` : ''} —\x1b[0m\r\n`)
    })

    void platform.terminal
      .attach(projectId, term.cols, term.rows)
      .then((info) => {
        if (disposed) return
        idRef.current = info.terminalId
        setDead(!info.alive)
        // 지금까지의 출력을 되살린다 — 붙을 때마다 빈 화면이면 터미널이 아니다
        if (info.history) term.write(info.history)
        safeFit()
        void platform.terminal.resize(info.terminalId, term.cols, term.rows).catch(() => {})
      })
      .catch((e: Error) => !disposed && setError(e.message))

    const onData = term.onData((data) => {
      const id = idRef.current
      if (id) void platform.terminal.input(id, data).catch(() => {})
    })

    // 패널 폭·창 크기가 바뀌면 셸에도 알려야 줄바꿈이 깨지지 않는다
    const ro = new ResizeObserver(() => {
      safeFit()
      const id = idRef.current
      if (id) void platform.terminal.resize(id, term.cols, term.rows).catch(() => {})
    })
    ro.observe(el)

    return () => {
      disposed = true
      ro.disconnect()
      onData.dispose()
      offOutput()
      offExit()
      term.dispose()
      termRef.current = null
      // **셸은 죽이지 않는다.** 탭을 옮긴 것뿐이고, 터미널은 프로젝트의 것이다
    }
  }, [platform, projectId])

  // 폭이 바뀐 뒤 한 번 더 맞춘다 (ResizeObserver가 놓치는 경우 대비)
  useEffect(() => {
    const id = idRef.current
    const term = termRef.current
    if (!id || !term) return
    const t = setTimeout(() => {
      void platform.terminal.resize(id, term.cols, term.rows).catch(() => {})
    }, 60)
    return () => clearTimeout(t)
  }, [width, platform])

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="evidence-terminal">
      {error && (
        <p className="px-3 py-2 text-[11px] leading-relaxed text-ash" data-testid="terminal-error">
          터미널을 열 수 없습니다 — {error}
        </p>
      )}
      {dead && !error && (
        <div className="flex items-center gap-2 border-b border-edge px-3 py-1">
          <span className="text-[10px] text-slate">셸이 종료됨</span>
          <button
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-ash transition-colors hover:bg-graphite/50 hover:text-chalk"
            data-testid="terminal-restart"
            onClick={async () => {
              const id = idRef.current
              const term = termRef.current
              if (!id || !term) return
              const info = await platform.terminal.restart(id, term.cols, term.rows)
              idRef.current = info.terminalId
              setDead(!info.alive)
              term.reset()
              if (info.history) term.write(info.history)
            }}
          >
            다시 시작
          </button>
        </div>
      )}
      <div ref={hostRef} className="min-h-0 flex-1 px-1 py-1" data-testid="terminal-surface" />
    </section>
  )
}
