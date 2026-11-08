import type { CentraluTools, SessionApps } from '../contract.js'

/**
 * What a recorded session is given in place of a host (#1498): Centralu's own tools and an attached app, answered with fixed words.
 * The tool being recorded is real (its calls, its tool names, how it reads an answer); the host behind the tools is not, so a
 * recording made with these holds the shape of Centralu's tool results but not the data a host would put in them. The
 * answers are fixed so that a replay sends the recording's own lines.
 */

const SESSION = { sessionId: 'session-other', sessionName: 'Docs worker', tool: 'claude' } as const

/** The slice of `CentraluTools` the scenarios call; the reader's tool set */
export function fakeCentraluTools(): CentraluTools {
  const tools: Partial<CentraluTools> = {
    mail: (args) => {
      if (args.action === 'inbox') return { text: 'Inbox: 1 message.\n- m1 from Docs worker (question, needs reply): "Which license file should the readme link to?"' }
      if (args.action === 'read') return { text: 'm1 from Docs worker (question):\n> Which license file should the readme link to?' }
      if (args.action === 'send') return { text: `Sent to ${args.to ?? 'the recipient'}. It needs a reply, so the answer will arrive in your inbox.` }
      return { text: 'Done.' }
    },
    recall: async (query) => ({
      hits: [{ sessionId: SESSION.sessionId, session: SESSION.sessionName, project: 'demo', snippet: `...we settled the ${query} question by keeping the old name...`, seq: 12, at: '2026-01-02' }],
    }),
    readSession: async () => ({
      ok: true,
      state: 'idle',
      lines: ['[1] person: Rename the helper to parseFlags.', '[2] agent: Renamed it in two files and ran the tests; all pass.'],
    }),
    startAgent: async () => ({ ok: true, ...SESSION, state: 'done', answer: 'The notes file lists three open items.', readable: [], outside: [] }),
    compactSelf: (focus) => ({ text: `Compacting after this turn${focus ? `, keeping: ${focus}` : ''}.` }),
  }
  return tools as CentraluTools
}

/** What a stand-in tool was handed: its name and the arguments the call carried */
export type Handed = { tool: string; args: unknown }

/**
 * The tools a host answered for in a recording made through one (`host: true`): the reader's fakes plus the tools only a host can answer
 * (another agent, another project), each noting its arguments in `handed` and answering a minimal success. A call that never reached its
 * tool, or reached it with other arguments, shows in `handed`; the words of the answer are not the recording's, which a replay does not compare.
 */
export function notingCentraluTools(handed: Handed[]): CentraluTools {
  const note = <T,>(tool: string, answer: T) => async (...args: unknown[]): Promise<T> => (handed.push({ tool, args: args[0] }), answer)
  const child = { ok: true as const, sessionId: 'child-1', sessionName: 'child', tool: 'claude', state: 'done' as const, answer: 'noted', readable: [], outside: [] }
  const base = fakeCentraluTools()
  return {
    ...base,
    readSession: async (...args: Parameters<CentraluTools['readSession']>) => (handed.push({ tool: 'read_session', args: args[0] }), base.readSession(...args)),
    startAgent: note('start_agent', child),
    agentSession: note('agent_session', child),
    askProject: note('ask_project', { ok: true as const, state: 'done' as const, project: 'frames-record-other', sessionId: 'other-1', sessionName: 'other', answer: 'noted', readable: [], outside: [] }),
  }
}

/** An attached app with one read-only tool, as `SessionApps` hands them to an adapter */
export function fakeApps(): SessionApps {
  const server = 'app-weather'
  const tools = [
    {
      name: 'forecast',
      description: 'The forecast for a city',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      annotations: { readOnlyHint: true },
    },
  ]
  return {
    current: () => [{ server, appId: 'weather', tools }],
    onChange: () => () => {},
    tools: async () => tools,
    call: async (_server, tool, args) => ({ content: [{ type: 'text', text: tool === 'forecast' ? `Forecast for ${String(args.city)}: sunny, 21 degrees.` : `No such tool: ${tool}` }], isError: tool !== 'forecast' }),
    noteCall: () => {},
    callEnded: () => {},
    readOnly: (_server, tool) => tools.find((t) => t.name === tool)?.annotations.readOnlyHint === true,
    unasked: (_server, tool) => tools.find((t) => t.name === tool)?.annotations.readOnlyHint === true,
    cancelAll: () => {},
    close: () => {},
  }
}
