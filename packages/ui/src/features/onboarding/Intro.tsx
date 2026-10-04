import { useCallback, useEffect, useState } from 'react'
import type { ToolStatus } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'

/**
 * The intro screen (#63) — exactly once, on the very first run: "meet your orchestrator."
 *
 * Replaces FirstRun (folder first). The reason is not efficiency but **habit**: someone who
 * never goes through the experience of asking the orchestrator something on the first run does
 * not click it later either — a person only uses what they have already tried. This app's
 * question-answering channel is the orchestrator, not the people who built it.
 *
 * **The card doubles as the detection display.** There is no separate tool-detection screen — a
 * ready tool gets a live card, and a tool that is not ready gets a dim card with "Not connected"
 * and the prescription (an install or login command) standing right there together. Where the
 * state is shown and where the action happens are the same spot.
 *
 * **Clicking a card only records the choice; no process starts** (lazy start). The orchestrator
 * is not actually born until the first question is asked on the next screen.
 */
export function Intro() {
  const platform = usePlatform()
  const completeIntro = useStore((s) => s.completeIntro)
  const [tools, setTools] = useState<ToolStatus[] | null>(null)

  const detect = useCallback(async () => {
    try {
      setTools(await platform.agents.detect())
    } catch {
      setTools([])
    }
  }, [platform])

  useEffect(() => {
    void detect()
  }, [detect])

  const ready = (t: ToolStatus) => t.installed && t.loggedIn
  const anyReady = (tools ?? []).some(ready)
  // detect returns **every** tool along with its status — the reason even an uninstalled tool gets a card
  const cards = tools ?? []

  return (
    <div className="flex flex-1 items-center justify-center px-8" data-testid="intro">
      <div className="w-full max-w-xl">
        {/*
          **One line is all there is.** Nobody reads a three-paragraph explanation before
          starting — the longer it is, the less it gets read, and unread, this screen teaches
          nothing and just collects a click (a dogfooding observation). The one sentence worth
          keeping is the single reason this screen exists: **there is someone to talk to.**
          Everything else is left to the suggested-question cards on the next screen.
        */}
        <h1 className="text-[19px] font-medium tracking-tight text-ink" data-testid="intro-role">
          Meet your <span className="text-ink">orchestrator</span>.
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
          It watches every session and answers whatever you ask about this app.
        </p>
        <p className="mt-5 text-[12px] text-ink-faint">Run it on:</p>

        <div className="mt-2 grid grid-cols-2 gap-3">
          {cards.map((t) => {
            const ok = ready(t)
            return (
              <button
                key={t.name}
                data-testid={`intro-card-${t.name}`}
                disabled={!ok}
                onClick={() => void completeIntro(t.name)}
                /*
                 * Disabled is **dim** (user requirement) — gray text is the convention for
                 * "not available right now," and here that convention happens to be exactly
                 * true.
                 */
                className={`rounded-lg border px-4 py-4 text-left transition-colors ${
                  ok
                    ? 'border-line bg-surface-raised hover:border-line-strong'
                    : 'cursor-not-allowed border-line/60 bg-surface-raised/40 opacity-40'
                }`}
              >
                <span className="block text-[14px] font-medium text-ink">{t.label}</span>
                {ok ? (
                  <span className="readout mt-1 block text-[11px] text-ink-faint">{t.detail}</span>
                ) : (
                  <>
                    {/* The diagnosis at a glance, the prescription right below it — an eye that does not know a terminal comes first */}
                    <span className="mt-1 block text-[12px] text-ink-muted" data-testid={`intro-card-${t.name}-status`}>
                      Not connected
                    </span>
                    <code className="mt-1.5 block truncate rounded bg-surface-side px-1.5 py-1 font-mono text-[10px] text-ink-faint">
                      {t.installed ? t.login : t.install}
                    </code>
                  </>
                )}
              </button>
            )
          })}
        </div>

        {/* A low-stakes choice is what makes a click happen — this pick does not nail anything down */}
        <p className="mt-2 text-[11px] text-ink-faint">You can change this later in Settings.</p>

        {tools === null ? (
          <p className="mt-4 text-[11px] text-ink-faint">Looking for Claude Code and Codex…</p>
        ) : (
          <>
            {!anyReady && (
              <p className="mt-4 text-[11px] leading-relaxed text-ink-muted" data-testid="intro-blocked">
                No tool is ready yet — run a command above in your terminal, then check again.
              </p>
            )}
            {/* Always present — a way for someone who just installed it in the terminal and came back to re-run detection */}
            <button
              className="mt-1.5 text-[11px] text-ink-faint underline-offset-2 hover:text-ink hover:underline"
              onClick={() => void detect()}
              data-testid="redetect"
            >
              Check again
            </button>
          </>
        )}
      </div>
    </div>
  )
}
