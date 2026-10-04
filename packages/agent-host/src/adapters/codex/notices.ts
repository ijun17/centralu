import { homedir } from 'node:os'
import { APP_SERVER_PREFIX, RESERVED_NAME_PREFIX } from '@cc/protocol'

/**
 * What makes a Codex notice readable at a glance (#342): who is speaking, what kind of notice it is, who has to act,
 * and for the notices we know, a plain one-line explanation that comes before Codex's own words.
 *
 * The owner saw two lines in a row (packaged 0.1.0-beta.9, codex-cli 0.160.0): Codex ignoring two `config.toml` keys,
 * which is the person's to fix, and Codex telling Centralu that its way of loading a thread's history is deprecated,
 * which the person can do nothing about. Both read like the same kind of problem. The decision (issue comment,
 * 2026-10-05) keeps both in the conversation and says, on the line itself, whose they are.
 *
 * Codex's text is never rewritten: it stays in the notice's `text` and is one click away, so a cause we did not
 * anticipate is not lost (the same rule as an error marker).
 */
export type NoticeWords = {
  from: 'Codex'
  label: string
  audience?: 'you' | 'centralu'
  summary?: string
  items?: string[]
  hint?: string
}

/** The kinds of notice the adapter maps, in the words the line uses */
const LABELS = {
  configWarning: 'config warning',
  warning: 'warning',
  deprecationNotice: 'deprecation',
  guardianWarning: 'auto-review warning',
  'model/rerouted': 'model rerouted',
  mcpStartup: 'MCP server',
  settings: 'thread settings',
} as const

export type NoticeKind = keyof typeof LABELS

/**
 * One line of Codex's unknown-key warning. Measured (codex-cli 0.160.0):
 * `  user (/Users/…/.codex/config.toml): \`mcp_servers.plane.type\` is ignored.` The layer word (`user`) is Codex's;
 * a project's own `.codex/config.toml` is another layer with the same shape.
 */
const IGNORED_LINE = /^\s*[\w-]+ \((.+?)\): `([^`]+)` is ignored\.?\s*$/
const IGNORED_HEAD = /^Codex is ignoring \d+ unrecognized configuration settings?\b/

/**
 * Codex's three wordings of the full-history deprecation (codex-cli 0.160.0's binary): one for `thread/resume` and
 * `thread/fork` ("use `excludeTurns: true`"), one for `thread/read` ("omit `includeTurns`"). All start the same way.
 */
const HYDRATION = /^Full-history hydration is deprecated\b/

/** An app-server method named in a notice — what a notice about Centralu's API use mentions and a config one does not */
const API_METHOD = /`?\b(thread|turn|review)\/[a-z]/

function tilde(path: string): string {
  const home = homedir()
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function ignoredSettings(text: string): Pick<NoticeWords, 'summary' | 'items' | 'hint'> | null {
  const lines = text.split('\n')
  if (!IGNORED_HEAD.test(lines[0] ?? '')) return null
  const found = lines.slice(1).flatMap((l) => {
    const m = IGNORED_LINE.exec(l)
    return m ? [{ file: tilde(m[1]!), key: m[2]! }] : []
  })
  if (found.length === 0) return null
  const files = [...new Set(found.map((f) => f.file))]
  const n = found.length
  const them = n === 1 ? 'it' : 'them'
  return files.length === 1
    ? {
        summary: `Codex ignored ${n} ${n === 1 ? 'setting' : 'settings'} in \`${files[0]}\``,
        items: found.map((f) => f.key),
        hint: `Codex already runs without ${them}; removing ${them} from the file only silences this notice.`,
      }
    : {
        summary: `Codex ignored ${n} settings in ${files.length} config files`,
        items: found.map((f) => `${f.key} (${f.file})`),
        hint: `Codex already runs without them; removing them from those files only silences this notice.`,
      }
}

/**
 * The readable parts of a notice of `kind` whose Codex text is `text`. `mcpServer` is the server's name, for an MCP
 * start failure.
 */
export function noticeWords(kind: NoticeKind, text: string, mcpServer?: string): NoticeWords {
  const words: NoticeWords = { from: 'Codex', label: LABELS[kind] }
  /*
   * The unknown-key warning arrives twice, as `configWarning` and as the thread's `warning` with the same text
   * (measured, #304). Recognized by its text, so whichever is stored first (`configWarning`, which comes while
   * `thread/start` is answered) reads the same.
   */
  const ignored = kind === 'configWarning' || kind === 'warning' ? ignoredSettings(text) : null
  if (ignored) return { ...words, audience: 'you', ...ignored }
  switch (kind) {
    case 'configWarning':
      return { ...words, audience: 'you' }
    case 'deprecationNotice':
      if (HYDRATION.test(text)) {
        return {
          ...words,
          audience: 'centralu',
          summary: 'Codex says Centralu loads thread history in an outdated way',
          hint: 'Nothing to do on your side; Centralu will switch to the paginated API (#342).',
        }
      }
      // Codex's other deprecations are about `config.toml` keys (`[features].x` is deprecated…) or about API use
      if (API_METHOD.test(text)) return { ...words, audience: 'centralu' }
      if (/config\.toml|\[features/.test(text)) return { ...words, audience: 'you' }
      return words
    case 'mcpStartup':
      /*
       * Centralu's own orchestrator bridge is ours to fix. An app's bridge (`app-<id>`) may fail for the app's own
       * reasons, so it is left unsaid. Any other server is one the person put in their Codex config.
       */
      if (mcpServer === RESERVED_NAME_PREFIX) return { ...words, audience: 'centralu' }
      return mcpServer && !mcpServer.startsWith(APP_SERVER_PREFIX) ? { ...words, audience: 'you' } : words
    default:
      return words
  }
}
