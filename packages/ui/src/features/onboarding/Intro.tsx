import type { ToolStatus } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { ToolSetupLine } from '../tools/ToolSetupLine.jsx'
import { useLiveTools, useReloadOnReconnect } from '../tools/useToolSetup.js'
import { ORCHESTRATOR_DEMANDS, useRefusals } from '../project/useToolChoice.js'

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
  /*
   * A detection that fails is not "no tool is ready" (#850 item 8): it used to read as an empty list, which drew no card
   * and told the person to run a command "above" that was not there. It says what failed, with the same way to ask again.
   */
  const detected = useLoad<ToolStatus[]>(() => platform.agents.detect(), [platform])
  const tools = useLiveTools(detected.data ?? null)
  useReloadOnReconnect(detected.reload)
  const detect = detected.reload

  // A tool that cannot take the orchestrator's role is shown with the reason, as one not connected is
  const refusal = useRefusals(tools, ORCHESTRATOR_DEMANDS)
  const ready = (t: ToolStatus) => t.installed && t.loggedIn && refusal(t.name) === null
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
        <h1 className="text-display font-medium tracking-tight text-ink" data-testid="intro-role">
          Meet your <span className="text-ink">orchestrator</span>.
        </h1>
        <p className="mt-2 text-md leading-body text-ink-muted">
          It watches every session and answers whatever you ask about this app.
        </p>
        <p className="mt-5 text-sm text-ink-faint">Run it on:</p>

        <div className="mt-2 grid grid-cols-2 gap-3">
          {cards.map((t) => {
            const ok = ready(t)
            // A tool Centralu installs or signs in itself holds its action in the card; the others show the command to run, as before
            const managed = t.setup?.install === 'centralu' || t.setup?.signIn === 'centralu'
            // A card whose line holds buttons of its own (Install, Sign in) is not a <button>, which may not hold one: it acts as one once it can be picked
            const Card = managed ? 'div' : 'button'
            const pick = () => void completeIntro(t.name)
            return (
              <Card
                key={t.name}
                data-testid={`intro-card-${t.name}`}
                {...(managed
                  ? ok
                    ? { role: 'button', tabIndex: 0, onClick: pick, onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.target !== e.currentTarget) return
                        if (e.key === ' ') e.preventDefault()
                        if (e.key === 'Enter') pick()
                      },
                      onKeyUp: (e: React.KeyboardEvent) => e.target === e.currentTarget && e.key === ' ' && pick() }
                    : {}
                  : { disabled: !ok, onClick: pick })}
                /*
                 * Disabled is **dim** (user requirement) — gray text is the convention for
                 * "not available right now," and here that convention happens to be exactly
                 * true. A card with an action in it dims its words, not the action: a dimmed Install reads as disabled.
                 */
                className={`rounded-lg border px-4 py-4 text-left transition-colors ${
                  ok
                    ? 'border-line bg-surface-raised hover:border-line-strong'
                    : managed
                      ? // Dimmed only before it is installed: installed and waiting for a sign-in it is the person's next step, so not faded
                        t.installed
                        ? 'cursor-default border-line bg-surface-raised'
                        : 'cursor-default border-line/60 bg-surface-raised/40'
                      : 'cursor-not-allowed border-line/60 bg-surface-raised/40 opacity-40'
                }`}
              >
                <span className={`block text-md font-medium text-ink ${managed ? `transition-opacity duration-150 ${t.installed ? '' : 'opacity-40'}` : ''}`}>{t.label}</span>
                {managed ? (
                  <>
                    {ok && <span className="readout cc-setup-swap mt-1 block text-xs text-ink-faint">{t.detail}</span>}
                    <ToolSetupLine
                      status={t}
                      label={t.label}
                      login={t.login}
                      shown={!ok}
                      refusal={refusal(t.name)}
                      terminal={{ login: (label, command) => `${label}: run ${command} in a terminal`, missing: (label) => `${label} is not installed` }}
                      redetect={() => void detect()}
                      testId={`intro-card-${t.name}-setup`}
                      className="mt-1.5 text-xs leading-body text-ink-muted"
                    />
                  </>
                ) : ok ? (
                  <span className="readout mt-1 block text-xs text-ink-faint">{t.detail}</span>
                ) : (
                  <>
                    {/* The diagnosis at a glance, the prescription right below it — an eye that does not know a terminal comes first */}
                    <span className="mt-1 block text-sm text-ink-muted" data-testid={`intro-card-${t.name}-status`}>
                      {refusal(t.name) ?? 'Not connected'}
                    </span>
                    {refusal(t.name) === null && (
                      <code className="mt-1.5 block truncate rounded-md bg-surface-side px-1.5 py-1 font-mono text-2xs text-ink-faint">
                        {t.installed ? t.login : t.install}
                      </code>
                    )}
                  </>
                )}
              </Card>
            )
          })}
        </div>

        {/* A low-stakes choice is what makes a click happen — this pick does not nail anything down */}
        <p className="mt-2 text-xs text-ink-faint">You can change this later in Settings.</p>

        {tools === null && detected.error === null ? (
          <p className="mt-4 text-xs text-ink-faint">Looking for Claude Code and Codex…</p>
        ) : (
          <>
            {detected.error !== null && (
              <LoadFailed what="which tools are installed" error={detected.error} className="mt-4" testId="intro-detect-failed" />
            )}
            {tools !== null && !anyReady && (
              <p className="mt-4 text-xs leading-body text-ink-muted" data-testid="intro-blocked">
                No tool is ready yet — run a command above in your terminal, then check again.
              </p>
            )}
            {/* Always present — a way for someone who just installed it in the terminal and came back to re-run detection */}
            <button
              className="mt-1.5 text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
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
