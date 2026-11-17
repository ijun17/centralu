import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isObj } from '../../json-value.js'
import { __setSessionApiForTest, readClaudeHistory, writtenByTheCli, type TranscriptEntry } from './history.js'

/**
 * Who wrote a user line of an imported conversation (#2323): Claude Code's task notification came back from a catch-up
 * as the person's message. The transcripts under `transcripts/` are real ones (see its README), read here by the real SDK
 * from a configuration folder of the test's own, so what the SDK keeps and drops of each line is measured, not assumed.
 */

const TRANSCRIPTS = `${import.meta.dirname}/transcripts`
const SESSIONS = { '2.1.296': '7a1d2c3e-0000-4000-8000-000000002296', '2.1.263': '7a1d2c3e-0000-4000-8000-000000002263' } as const
type Version = keyof typeof SESSIONS

const fixture = (v: Version): string => join(TRANSCRIPTS, `claude-code-${v}`, 'provenance.jsonl')
const entries = (v: Version): TranscriptEntry[] =>
  readFileSync(fixture(v), 'utf8').split('\n').filter(Boolean).map((l): unknown => JSON.parse(l)).filter(isObj)

let root = ''
let cwd = ''
const configDir = process.env.CLAUDE_CONFIG_DIR

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-claude-provenance-'))
  cwd = realpathSync(mkdtempSync(join(root, 'project-')))
  // Where the CLI keeps a folder's transcripts: its path with every other character a dash
  const dir = join(root, 'config', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  for (const v of Object.keys(SESSIONS) as Version[]) copyFileSync(fixture(v), join(dir, `${SESSIONS[v]}.jsonl`))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
})

afterAll(() => {
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = configDir
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => __setSessionApiForTest(undefined))

/** The SDK as installed, for the reads history.ts makes, without `importSessionToStore` unless a test gives one */
async function installedSdk(importSessionToStore?: () => Promise<void>): Promise<Parameters<typeof __setSessionApiForTest>[0]> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return { listSessions: sdk.listSessions, getSessionMessages: sdk.getSessionMessages, ...(importSessionToStore ? { importSessionToStore } : {}) }
}

const SAY_HI = [
  { role: 'user', text: 'say hi' },
  { role: 'assistant', text: 'Hi! What would you like to work on?' },
  { role: 'user', text: 'hi', sent: true }, // the line's id is one Centralu gave its input
  { role: 'system', event: { type: 'compaction', sessionId: '', failed: false } },
]

describe('claude history — who wrote a user line (#2323)', () => {
  it("drops the CLI's task notification from the person's words, by what the transcript says of the line", async () => {
    expect(await readClaudeHistory(SESSIONS['2.1.296'], cwd, 100)).toEqual(SAY_HI)
    // 2.1.263 wrote the notification as an SDK prompt: its origin is what says it is the CLI's
    expect(await readClaudeHistory(SESSIONS['2.1.263'], cwd, 100)).toEqual([{ role: 'user', text: 'Reply OK. Use no tools.' }])
  })

  it("judges every recorded user line by its own fields: the person's words, the CLI's, or left to the text rules", () => {
    const person = ['say hi', 'hi', 'Reply OK']
    const unsaid = ['<command-name>', '<local-command-stdout>', 'This session is being continued'] // no field says who
    const verdicts = (['2.1.296', '2.1.263'] as const).flatMap((v) =>
      entries(v)
        .filter((e) => e.type === 'user')
        .map((e) => {
          const m = isObj(e.message) ? e.message.content : undefined
          const text = typeof m === 'string' ? m : Array.isArray(m) && isObj(m[0]) ? String(m[0].text) : ''
          return { text: text.slice(0, 40), cli: writtenByTheCli(e) }
        }),
    )
    expect(verdicts.length).toBe(15)
    for (const { text, cli } of verdicts) {
      const expected = ![...person, ...unsaid].some((p) => text.startsWith(p))
      expect({ text, cli }).toEqual({ text, cli: expected })
    }
  })

  // Hand-written: every recorded line the CLI wrote also carries a tag the text rules know, so only a line without one
  // shows that the entry's fields, not its words, decide (a kind the CLI adds later would be such a line)
  it("takes the entry's word over the text: a line the CLI wrote in plain words is not the person's", async () => {
    const uuid = '4d66f5ba-7ef4-499a-9559-24e73a18e626'
    __setSessionApiForTest({
      getSessionMessages: async (_id, o) => {
        expect(o?.sessionStore).toBeDefined()
        return [
          { type: 'user', uuid: 'a22cef78-3d77-45db-ac78-ce6ef0813641', message: { content: 'say hi' } },
          { type: 'user', uuid, message: { content: 'Background task finished' } },
        ]
      },
      importSessionToStore: async (_id, store) => store.append({}, [{ type: 'user', uuid, promptSource: 'system', origin: { kind: 'a-later-kind' } }]),
    })
    expect(await readClaudeHistory('s', cwd, 100)).toEqual([{ role: 'user', text: 'say hi' }])
  })

  it('falls back to the text rules when the SDK cannot hand over the entries, and says why when it fails', async () => {
    // An SDK without the export: the notification is still known by its tag
    __setSessionApiForTest(await installedSdk())
    expect(await readClaudeHistory(SESSIONS['2.1.296'], cwd, 100)).toEqual(SAY_HI)
    // An export that fails: the rows are read from disk as before, and the log says why
    __setSessionApiForTest(
      await installedSdk(async () => {
        throw new Error('store refused')
      }),
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await readClaudeHistory(SESSIONS['2.1.296'], cwd, 100)).toEqual(SAY_HI)
      expect(log.mock.calls.flat().join(' ')).toContain('store refused')
    } finally {
      log.mockRestore()
    }
  })
})
