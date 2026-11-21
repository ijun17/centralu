import { errorMessage } from '@cc/protocol/client'
import { useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { SessionPane } from '../session/SessionView.jsx'
import { fitComposerHeight } from '../session/composerFit.js'
import { useSendKey } from '../session/useSendKey.js'
import { guiCommandFor } from '../session/guiCommands.js'

/**
 * Control by talking: SessionPane itself once a session exists, so no copy holds a stale model. Before, an empty
 * conversation (#63): a process starts only with a suggested question or the first word. Suggestions follow the message
 * count, not an onboarding state. No evidence panel: without a project there is no git or files.
 */
export function AssistantView() {
  const id = useStore((s) => s.assistantId)
  // Not "empty" before the transcript loads, or the card would flash
  const chatEmpty = useStore((s) => (id ? s.chat[id] !== undefined && s.chat[id].length === 0 : false))
  const mcpProposals = useStore((s) => s.mcpProposals)
  const resolveMcpProposal = useStore((s) => s.resolveMcpProposal)
  const skillProposals = useStore((s) => s.skillProposals)
  const resolveSkillProposal = useStore((s) => s.resolveSkillProposal)

  if (!id)
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <AssistantEmpty />
      </div>
    )
  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      {/*
        MCP proposals (propose_mcp_server): a banner beside the conversation that proposed them, with the full command,
        since approving registers arbitrary command execution.
      */}
      {/*
        Skill proposals (#71): the full procedure, since approving gives lasting influence over the assistant.
      */}
      {skillProposals.map((p) => (
        <div
          key={p.name}
          className="flex items-start gap-3 border-b border-line bg-surface-raised px-4 py-2.5"
          data-testid={`skill-proposal-${p.name}`}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">
              Assistant proposes skill <span className="readout">{p.name}</span>
              {p.why && <span className="text-ink-muted"> — {p.why}</span>}
            </p>
            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-floor px-2 py-1.5 font-sans text-xs leading-body text-ink-muted">
              {p.content}
            </pre>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md border border-line-strong bg-surface-hover px-2.5 py-1 text-xs text-ink transition-colors hover:border-ink-muted"
            onClick={() => void resolveSkillProposal(p.name, true)}
            data-testid={`skill-approve-${p.name}`}
          >
            Save & restart
          </button>
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 text-xs text-ink-faint transition-colors hover:text-ink"
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
            <p className="text-sm text-ink">
              Assistant asks to install MCP server <span className="readout">{p.name}</span>
              {p.why && <span className="text-ink-muted"> — {p.why}</span>}
            </p>
            <p className="readout mt-0.5 truncate text-2xs text-ink-faint">
              {p.command} {p.args.join(' ')}
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md border border-line-strong bg-surface-hover px-2.5 py-1 text-xs text-ink transition-colors hover:border-ink-muted"
            onClick={() => void resolveMcpProposal(p.name, true)}
            data-testid={`mcp-approve-${p.name}`}
          >
            Install & restart
          </button>
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 text-xs text-ink-faint transition-colors hover:text-ink"
            onClick={() => void resolveMcpProposal(p.name, false)}
            data-testid={`mcp-dismiss-${p.name}`}
          >
            Dismiss
          </button>
        </div>
      ))}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <SessionPane sessionId={id} />
          {/*
            Also for an existing but empty session (never talked to, a failed send). An overlay, so SessionPane's
            composer and settings menu stay live underneath.
          */}
          {chatEmpty && (
            <div className="pointer-events-none absolute inset-x-0 bottom-24 top-0 flex items-center justify-center">
              <div className="pointer-events-auto">
                <Suggestions ask={(t) => void useStore.getState().send(id, t)} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Questions that end in an action (#63), not "what does this app do?": a project (create_project's approval card, #515),
 * this channel's reach, and running several sessions. A click sends at once and wakes the Assistant.
 */
const QUESTIONS = [
  { key: 'create-project', text: 'Create a project for me.' },
  { key: 'capabilities', text: 'What can you do as the Assistant?' },
  { key: 'multi-session', text: 'How do I run and watch several sessions at once?' },
] as const

function Suggestions({ ask }: { ask: (text: string) => void }) {
  const platform = usePlatform()
  const addProject = useStore((s) => s.addProject)
  const openNewSession = useStore((s) => s.openNewSession)
  const setToast = useStore((s) => s.setToast)
  const waking = useStore((s) => s.assistantWaking)
  const [picking, setPicking] = useState(false)
  // Disabled without the host: a call queues for a reconnect and fails only after 30 s, saying "starting" all along
  const connection = useStore((s) => s.connection)
  const offline = connection !== 'connected'

  return (
    <div className="w-full max-w-md px-6" data-testid="assistant-suggestions">
      <p className="text-md text-ink-muted">
        This is your <span className="text-ink">assistant</span>. Ask it anything about this
        app or your sessions — try one:
      </p>
      <div className="mt-3 space-y-2">
        {QUESTIONS.map((q) => (
          <button
            key={q.key}
            data-testid={`suggest-${q.key}`}
            disabled={waking || offline}
            onClick={() => ask(q.text)}
            className="block w-full rounded-lg border border-line bg-surface-raised px-4 py-3 text-left text-md text-ink transition-colors hover:border-line-strong disabled:opacity-50"
          >
            {q.text}
          </button>
        ))}
      </div>
      {waking && !offline && (
        <p className="mt-2 text-xs text-ink-faint" data-testid="assistant-waking">
          Starting the Assistant…
        </p>
      )}
      {offline && (
        <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="assistant-offline">
          {connection === 'connecting'
            ? 'Connecting to the agent host…'
            : 'Not connected to the agent host — nothing can start until it is back.'}
        </p>
      )}
      {/*
        #63's way out without talking: picker, project, new-session window.
      */}
      <button
        className="mt-3 text-sm text-ink-faint underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
        data-testid="assistant-pick-folder"
        disabled={picking || offline}
        onClick={async () => {
          setPicking(true)
          try {
            const picked = await platform.system.pickDirectory()
            if (picked) openNewSession((await addProject(picked)).id)
          } catch (e) {
            setToast(errorMessage(e))
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

/** SessionPane needs a session id, so this imitates its skeleton until the first word starts the real one */
function AssistantEmpty() {
  const askAssistant = useStore((s) => s.askAssistant)
  const waking = useStore((s) => s.assistantWaking)
  const sendKey = useSendKey()
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // The box grows with its text, as the session's composer does (#1143 U17)
  useLayoutEffect(() => {
    if (inputRef.current) fitComposerHeight(inputRef.current)
  }, [text])

  const submit = () => {
    const t = text.trim()
    if (!t || waking) return
    setText('')
    // /usage opens its screen as in a session's composer (#1143 U17); a session command (/model) has none yet, so goes as text
    const gui = guiCommandFor(t, false)
    if (gui) return gui.run({ sessionId: null })
    // A start that failed puts the question back (#180), before anything typed since: it never reached send, which
    // restores a failed send into the session's draft.
    void askAssistant(t).then((ok) => {
      if (!ok) setText((cur) => (cur ? `${t}\n${cur}` : t))
    })
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="assistant-empty">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Suggestions ask={(t) => void askAssistant(t)} />
      </div>
      {/* Dressed as the real composer, which takes this spot a moment later */}
      <div className="shrink-0 px-4 pb-4">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          disabled={waking}
          onChange={(e) => setText(e.target.value)}
          // The session composer's rule (#180): with ⌘Enter to send, Enter is a newline; Enter mid-composition never sends
          onKeyDown={(e) => sendKey(e) && submit()}
          placeholder="Ask the Assistant anything…"
          className="max-h-40 w-full resize-none rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-md text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none disabled:opacity-50"
          data-testid="assistant-input"
        />
      </div>
    </div>
  )
}
