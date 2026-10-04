import { useEffect, useState } from 'react'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { SessionPane } from '../session/SessionView.jsx'
import { composingKey, isComposerSendKey } from '../session/composerKeys.js'
import { APPS } from '../../apps/registry.js'
import { RAIL_DEFAULT, RAIL_MAX, RAIL_MIN } from '../../store/store.js'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'

/**
 * The orchestrator screen — **control by talking**.
 *
 * If a session exists, it uses SessionPane as is. A grid panel and the focus view are the same
 * component too — a separate copy would let one side change the model and leave the other
 * holding a stale value.
 *
 * **If no session exists, an empty conversation waits for the first question** (#63). Opening
 * the screen does not create a process — what creates one is clicking a suggested question or
 * typing the first word into the composer (askOrchestrator). Before that, this screen only shows
 * "a place you can talk to."
 *
 * Suggested questions stand **only while the conversation is empty** — a function of the message
 * count, not an onboarding state machine. They disappear once the first word exists, and from
 * then on this is an ordinary session screen.
 *
 * There is no evidence panel on the right. This session has no project, so there is no git and
 * no files to see — putting up an empty panel would leave people asking "what am I supposed to
 * look at here" every time.
 */
export function OrchestratorView() {
  const id = useStore((s) => s.orchestratorId)
  // Does not assume "empty" before the transcript has even loaded — the card would flash and disappear
  const chatEmpty = useStore((s) => (id ? s.chat[id] !== undefined && s.chat[id].length === 0 : false))
  const mcpProposals = useStore((s) => s.mcpProposals)
  const resolveMcpProposal = useStore((s) => s.resolveMcpProposal)
  const skillProposals = useStore((s) => s.skillProposals)
  const resolveSkillProposal = useStore((s) => s.resolveSkillProposal)

  // The rail (#81) stands even without an orchestrator session — a person's workbench is not an accessory to the chat
  if (!id)
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <OrchestratorEmpty />
        <AppRails />
      </div>
    )
  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      {/*
        MCP server proposal card (propose_mcp_server → option b: one-click approval by the
        person). Stands as a banner over the conversation — the decision has to be made right
        next to the conversation context the orchestrator proposed it in. Approving it registers
        arbitrary command execution, so the full command is shown as is.
      */}
      {/*
        Skill proposal card (#71). Approving it grants **lasting influence** over the
        orchestrator, so the full procedure is shown as is — a skill approved from just a summary
        is an unread contract. A long body scrolls inside its own box.
      */}
      {skillProposals.map((p) => (
        <div
          key={p.name}
          className="flex items-start gap-3 border-b border-line bg-surface-raised px-4 py-2.5"
          data-testid={`skill-proposal-${p.name}`}
        >
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-ink">
              Orchestrator proposes skill <span className="readout">{p.name}</span>
              {p.why && <span className="text-ink-muted"> — {p.why}</span>}
            </p>
            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-line bg-surface-floor px-2 py-1.5 font-sans text-[11px] leading-relaxed text-ink-muted">
              {p.content}
            </pre>
          </div>
          <button
            type="button"
            className="shrink-0 rounded border border-ink-muted/50 bg-surface-hover px-2.5 py-1 text-[11px] text-ink transition-colors hover:border-ink-muted"
            onClick={() => void resolveSkillProposal(p.name, true)}
            data-testid={`skill-approve-${p.name}`}
          >
            Save & restart
          </button>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 text-[11px] text-ink-faint transition-colors hover:text-ink"
            onClick={() => void resolveSkillProposal(p.name, false)}
            data-testid={`skill-dismiss-${p.name}`}
          >
            Dismiss
          </button>
        </div>
      ))}
      {mcpProposals.map((p) => (
        <div
          key={p.name}
          className="flex items-center gap-3 border-b border-line bg-surface-raised px-4 py-2.5"
          data-testid={`mcp-proposal-${p.name}`}
        >
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-ink">
              Orchestrator asks to install MCP server <span className="readout">{p.name}</span>
              {p.why && <span className="text-ink-muted"> — {p.why}</span>}
            </p>
            <p className="readout mt-0.5 truncate text-[10px] text-ink-faint">
              {p.command} {p.args.join(' ')}
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded border border-ink-muted/50 bg-surface-hover px-2.5 py-1 text-[11px] text-ink transition-colors hover:border-ink-muted"
            onClick={() => void resolveMcpProposal(p.name, true)}
            data-testid={`mcp-approve-${p.name}`}
          >
            Install & restart
          </button>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 text-[11px] text-ink-faint transition-colors hover:text-ink"
            onClick={() => void resolveMcpProposal(p.name, false)}
            data-testid={`mcp-dismiss-${p.name}`}
          >
            Dismiss
          </button>
        </div>
      ))}
      {/*
        The chat (dispatch) sits in the center, the app rail (#80, #81) on the right — a control
        surface. Just as the right side of a session screen is the evidence panel, the right
        side of this screen is a place with a different identity: the person's workbench.
      */}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <SessionPane sessionId={id} />
          {/*
            The same card stands even when the session exists but the conversation is empty
            (created but never talked to, or a failed send) — the other half of the rule that
            the card is a function of message count. Why it floats as an overlay: SessionPane's
            composer and settings menu have to stay alive underneath it.
          */}
          {chatEmpty && (
            <div className="pointer-events-none absolute inset-x-0 bottom-24 top-0 flex items-center justify-center">
              <div className="pointer-events-auto">
                <Suggestions ask={(t) => void useStore.getState().send(id, t)} />
              </div>
            </div>
          )}
        </div>
        <AppRails />
      </div>
    </div>
  )
}

/**
 * The apps that stand in the rail (#81). All the core knows about an app is its one line in the
 * registry, and this just draws that registry — a disabled app is not drawn (not deleted).
 */
function AppRails() {
  const apps = useStore((s) => s.apps)
  const ensure = useStore((s) => s.ensureAppState)
  const railWidth = useStore((s) => s.railWidth)
  const setRailWidth = useStore((s) => s.setRailWidth)
  useEffect(() => {
    for (const a of APPS) if (a.railPanel) void ensure(a.id)
  }, [ensure])
  const mounted = APPS.filter((a) => a.railPanel && (apps[a.id]?.enabled ?? true))
  if (mounted.length === 0) return null
  /*
   * The width is the geometry of the slot (core) — the content belongs to the app, but how much
   * room it takes up is the screen's job, so it is stored in the workspace. Same handle grammar
   * as the evidence panel: drag the left edge, double-click resets to the default width.
   */
  return (
    <div
      className="relative flex shrink-0 border-l border-line"
      style={{ width: `${railWidth}px` }}
      data-testid="app-rails"
    >
      <ResizeHandle
        side="left"
        min={RAIL_MIN}
        max={RAIL_MAX}
        onResize={setRailWidth}
        onReset={() => setRailWidth(RAIL_DEFAULT)}
        testId="rail-resize"
      />
      {mounted.map((a) => {
        const Rail = a.railPanel!
        return <Rail key={a.id} />
      })}
    </div>
  )
}

/**
 * Suggested questions (#63) — **questions that end in an action, not something to read as an
 * answer**.
 *
 * There is no "what does this app do?": whoever downloaded it already roughly knows (user's
 * observation). Instead: one action (creating a project — it ends in a propose_project card),
 * one capability of this channel, and one reason someone picked this app (running several
 * sessions). **A click sends it right away** — there is no intermediate step that just fills the
 * composer. That click is the lazy-start trigger that wakes the orchestrator.
 */
const QUESTIONS = [
  { key: 'create-project', text: 'Create a project for me.' },
  { key: 'capabilities', text: 'What can you do as the orchestrator?' },
  { key: 'multi-session', text: 'How do I run and watch several sessions at once?' },
] as const

function Suggestions({ ask }: { ask: (text: string) => void }) {
  const platform = usePlatform()
  const addProject = useStore((s) => s.addProject)
  const openNewSession = useStore((s) => s.openNewSession)
  const setToast = useStore((s) => s.setToast)
  const waking = useStore((s) => s.orchestratorWaking)
  const [picking, setPicking] = useState(false)
  /*
   * Without the host, this invitation is a promise that cannot be kept (dogfooding, 2026-09-07:
   * "the connection was disconnected, but the orchestrator screen looked connected anyway").
   *
   * Clicking while disconnected does not just quietly do nothing — it is **worse**: an RPC call
   * queues up expecting a reconnect, so it only fails after waiting 30 seconds. For those 30
   * seconds, the screen says "starting" — something that is not true.
   */
  const connection = useStore((s) => s.connection)
  const offline = connection !== 'connected'

  return (
    <div className="w-full max-w-md px-6" data-testid="orchestrator-suggestions">
      <p className="text-[13px] text-ink-muted">
        This is your <span className="text-ink">orchestrator</span>. Ask it anything about this
        app or your sessions — try one:
      </p>
      <div className="mt-3 space-y-2">
        {QUESTIONS.map((q) => (
          <button
            key={q.key}
            data-testid={`suggest-${q.key}`}
            disabled={waking || offline}
            onClick={() => ask(q.text)}
            className="block w-full rounded-lg border border-line bg-surface-raised px-4 py-3 text-left text-[13px] text-ink transition-colors hover:border-line-strong disabled:opacity-40"
          >
            {q.text}
          </button>
        ))}
      </div>
      {waking && !offline && (
        <p className="mt-2 text-[11px] text-ink-faint" data-testid="orchestrator-waking">
          Starting the orchestrator…
        </p>
      )}
      {offline && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-muted" data-testid="orchestrator-offline">
          {connection === 'connecting'
            ? 'Connecting to the agent host…'
            : 'Not connected to the agent host — nothing can start until it is back.'}
        </p>
      )}
      {/*
        The path for someone who does not want to talk — no conversation is forced on them
        (#63's escape hatch). Exactly what FirstRun used to do: picker → project → all the way
        through to the new-session window.
      */}
      <button
        className="mt-3 text-[12px] text-ink-faint underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
        data-testid="orchestrator-pick-folder"
        disabled={picking || offline}
        onClick={async () => {
          setPicking(true)
          try {
            const picked = await platform.system.pickDirectory()
            if (picked) openNewSession((await addProject(picked)).id)
          } catch (e) {
            setToast((e as Error).message)
          } finally {
            setPicking(false)
          }
        }}
      >
        …or just pick a folder to start a session
      </button>
    </div>
  )
}

/**
 * The place for an orchestrator that has not been born yet. Since SessionPane cannot stand
 * without a session id, this lightly imitates the same skeleton (center content plus a composer
 * below) — the moment the first word arrives, the real SessionPane inherits this spot.
 */
function OrchestratorEmpty() {
  const askOrchestrator = useStore((s) => s.askOrchestrator)
  const waking = useStore((s) => s.orchestratorWaking)
  const sendWithModifierEnter = useStore((s) => s.prefs.sendWithModifierEnter)
  const [text, setText] = useState('')

  const submit = () => {
    const t = text.trim()
    if (!t || waking) return
    setText('')
    /*
     * If it never got born, the first question is put back (#180). A send failure after birth
     * is restored by send into the real session's draft, but a failure before birth never
     * reaches send, so the text had nowhere to live at all. Anything typed in the meantime is
     * not overwritten — it is kept after the restored text.
     */
    void askOrchestrator(t).then((ok) => {
      if (!ok) setText((cur) => (cur ? `${t}\n${cur}` : t))
    })
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="orchestrator-empty">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Suggestions ask={(t) => void askOrchestrator(t)} />
      </div>
      {/* Dressed identically to the real composer — a moment later, SessionPane's composer stands in this exact spot */}
      <div className="shrink-0 px-4 pb-4">
        <textarea
          rows={1}
          value={text}
          disabled={waking}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // The same rule as the session composer (#180) — for someone who turned on ⌘Enter to send, plain Enter is a newline, and Enter mid-composition never sends
            const composing = composingKey({ key: e.key, isComposing: e.nativeEvent.isComposing })
            const key = { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, composing }
            if (isComposerSendKey(key, sendWithModifierEnter)) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Ask the orchestrator anything…"
          className="w-full resize-none rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none disabled:opacity-40"
          data-testid="orchestrator-input"
        />
      </div>
    </div>
  )
}
