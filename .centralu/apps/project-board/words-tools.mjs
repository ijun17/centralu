// The private word list: private_words and edit_private_words.
import { centralu, z } from './runtime/centralu-app-runtime.mjs'
import { GitHubError } from './github.mjs'
import { answering, serially } from './handlers.mjs'
import { answer } from './reply.mjs'
import { normalizeWords } from './rules.mjs'
import { plural } from './util.mjs'

// The private word list: in the data folder, never in the repository (owner decision, 2026-10-06)
const WORDS_FILE = 'private-words.json'
const WORDS_MAX = 500
let words = null
export async function privateWords() {
  words ??= normalizeWords((await centralu.readJson(WORDS_FILE, { words: [] }))?.words)
  return words
}
async function editPrivateWords({ add = [], remove = [] }) {
  const before = await privateWords()
  const gone = new Set(remove.map((w) => String(w).replace(/\s+/g, ' ').trim().toLowerCase()))
  const next = normalizeWords([...before.filter((w) => !gone.has(w.toLowerCase())), ...add])
  if (next.length > WORDS_MAX) throw new GitHubError('input', `The list would hold ${next.length} words; it keeps at most ${WORDS_MAX}. Nothing changed.`)
  const lower = new Set(before.map((w) => w.toLowerCase()))
  const added = next.filter((w) => !lower.has(w.toLowerCase()))
  const removed = before.filter((w) => gone.has(w.toLowerCase()))
  await centralu.writeJson(WORDS_FILE, { words: next })
  words = next
  return { words: next, added, removed }
}
const wordsAnswer = (list, head) => answer([head, ...list.map((w) => `- ${w}`)].join('\n'), { count: list.length, words: list }, head)
const wordCount = (n) => plural(n, 'private word')

export const tools = {
  private_words: {
    config: {
      title: 'The private word list',
      description: "The words that must not appear in public text (comments, issues, pull requests, commits), kept in this app's data folder and never in the repository.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    handler: async () => {
      const list = await privateWords()
      return wordsAnswer(list, `${wordCount(list.length)}.`)
    },
  },

  edit_private_words: {
    config: {
      title: 'Edit the private word list',
      description: 'Add or remove words of the private list (matched whole, ignoring case). Answers the list.',
      inputSchema: z.object({
        add: z.array(z.string().min(1).max(100)).max(100).optional(),
        remove: z.array(z.string()).max(500).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    // One at a time like every other write: each edit reads the list and writes it whole
    handler: serially(
      answering(async (args) => {
        const r = await editPrivateWords(args)
        const said = [...(r.added.length ? [`added ${r.added.map((w) => `"${w}"`).join(', ')}`] : []), ...(r.removed.length ? [`removed ${r.removed.map((w) => `"${w}"`).join(', ')}`] : [])].join('; ')
        return wordsAnswer(r.words, `${said ? `${said[0].toUpperCase()}${said.slice(1)}` : 'Nothing changed'}. ${wordCount(r.words.length)}.`)
      }),
    ),
  },
}
