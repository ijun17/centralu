// Board items: list_items and get_items read them, set_item_fields and add_item write them.
import { z } from './runtime/centralu-app-runtime.mjs'
import { board, byPriority, columns, detailInput, FIELDS, forget, itemOf, itemRef, itemsAnswer, matches, none, pick, REF_HELP, unseen } from './board.mjs'
import { addContent, findContent, GitHubError, resolveOption, setOption } from './github.mjs'
import { answering, serially } from './handlers.mjs'
import { asError, failure, linesAnswer, reason } from './reply.mjs'
import { sleep } from './util.mjs'

// --- Writing: one item or a batch -------------------------------------------------------------------
const fieldInputs = {
  status: z.string().optional().describe('Status, for example "Ready" or "In review"'),
  priority: z.string().optional().describe('Priority: High, Medium or Low'),
  area: z.string().optional().describe('Area, for example "UI" or "Apps"'),
}
const batchInputs = (verb) => ({
  item: itemRef.optional().describe(`One issue or pull request: ${REF_HELP}`),
  items: z
    .array(z.union([itemRef, z.object({ item: itemRef, ...fieldInputs })]))
    .min(1)
    .max(50)
    .optional()
    .describe(`Several, ${verb} in this order: each ${REF_HELP}, or { item, status?, priority?, area? }`),
  ...fieldInputs,
})

// Failures after which the next items would fail the same way: stop there instead of repeating it.
const STOPS = new Set(['network', 'auth', 'scope', 'gh-missing', 'setup', 'forbidden', 'internal'])
const stops = (e) => STOPS.has(e instanceof GitHubError ? e.kind : 'internal')

/**
 * Turns `item` or `items` (plus the top-level fields, which apply to every entry that does not set
 * its own) into a list of entries, and checks every reference and option name before anything is
 * written: one wrong name changes nothing, and the answer says each problem once.
 */
function plan(b, { item, items, status, priority, area }, { needFields }) {
  if (item !== undefined && items !== undefined) throw new GitHubError('input', 'Give item (one) or items (a list), not both. Nothing changed.')
  if (item === undefined && items === undefined) throw new GitHubError('input', 'Give item (one) or items (a list). Nothing changed.')
  const shared = { status, priority, area }
  const problems = []
  const entries = (items ?? [item]).map((raw) => {
    const e = raw !== null && typeof raw === 'object' ? raw : { item: raw }
    const entry = { input: e.item, options: {} }
    try {
      entry.want = itemOf(e.item)
      entry.ref = entry.want.ref
    } catch (err) {
      problems.push(err.message)
      return entry
    }
    let any = false
    for (const key of FIELDS) {
      const value = e[key] ?? shared[key]
      if (value === undefined) continue
      any = true
      try {
        entry.options[key] = resolveOption(b.fields[key], value)
      } catch (err) {
        problems.push(err.message)
      }
    }
    if (needFields && !any) problems.push(`Nothing to change for ${entry.ref}: give status, priority or area.`)
    return entry
  })
  if (problems.length) throw new GitHubError('input', `${[...new Set(problems)].join(' ')} Nothing changed.`)
  return entries
}

const change = (d) => `${d.field} ${none(d.from)} → ${d.to}`
/** What a failed write did before it failed (`writeFields` puts it on the error). */
const doneThen = (err) => (err.done?.length ? `${err.done.map(change).join(', ')} done, then ` : '')

/**
 * Applies the planned options to one item, one field at a time, skipping a field that already has
 * the value. `item` is this batch's own copy, updated after each write so a later entry for the
 * same item starts from the truth. A failed write carries what was done.
 */
async function writeFields(b, item, options) {
  const done = []
  const same = []
  for (const key of FIELDS) {
    const option = options[key]
    if (!option) continue
    const field = b.fields[key].name
    if (item[key] === option.name) {
      same.push(`${field} already ${option.name}`)
      continue
    }
    try {
      await setOption(b.project.id, item.itemId, b.fields[key].id, option.id)
    } catch (e) {
      e.done = done
      throw e
    } finally {
      // Whether or not this write landed, the cached board can no longer be trusted.
      forget()
    }
    done.push({ field, from: item[key], to: option.name })
    item[key] = option.name
  }
  return { done, same }
}

/**
 * GitHub can take a moment to list an item that was just added: on 2026-10-04 the read right after
 * `addProjectV2ItemById` came back without it four times in a row, and a second read a few seconds
 * later had it. So a read that looks for items tries a few times, with short waits.
 */
const LIST_WAITS_MS = [0, 500, 1000, 1500, 2000]
async function findFresh(itemIds) {
  let last
  for (const ms of LIST_WAITS_MS) {
    if (ms) await sleep(ms)
    last = await board({ fresh: true })
    if (itemIds.every((id) => last.items.some((i) => i.itemId === id))) break
  }
  return { board: last, byId: new Map(last.items.map((i) => [i.itemId, i])) }
}

/**
 * Reads the touched items again, fresh, once for the whole batch, and adds to each line what
 * GitHub shows when it is not what was set. It never throws: by now something may have been
 * written, and a failed read must not hide that. Returns the summary's last words.
 */
async function readBack(rows) {
  // Only items that answer with a line: a failed one's line already says how far it got.
  const touched = rows.filter((r) => r.line && r.touched)
  if (!touched.length) return ''
  let byId
  try {
    ;({ byId } = await findFresh(touched.map((r) => r.itemId)))
  } catch (e) {
    return ` Reading it back from GitHub failed: ${e?.message ?? e}`
  }
  // A batch may name the same item twice: each field is checked on the last line that set it.
  const last = new Map()
  for (const r of touched) for (const k of FIELDS) if (r.options[k]) last.set(`${r.itemId} ${k}`, r)
  let off = 0
  for (const r of touched) {
    const now = byId.get(r.itemId)
    if (!now) {
      off += 1
      r.line += ' (GitHub did not list it when read back; look again in a moment)'
      continue
    }
    const wrong = FIELDS.filter((k) => last.get(`${r.itemId} ${k}`) === r && now[k] !== r.options[k].name).map((k) => `${r.fieldNames[k]} ${none(now[k])}`)
    if (wrong.length) {
      off += 1
      r.line += ` (but GitHub now shows ${wrong.join(', ')})`
    }
  }
  return off ? ` Read back from GitHub: ${off} differ${off === 1 ? 's' : ''}, see the line${off === 1 ? '' : 's'}.` : ' Read back from GitHub: as set.'
}

const count = (n, word) => (n ? [`${n} ${word}`] : [])

/** The answer of a write: one line per item, the failures, and `isError` only when nothing worked. */
function writeAnswer(b, ok, counts, failed, tail) {
  const summary = `Project ${b.project.title} on GitHub: ${[...counts, ...count(failed.length, 'failed')].join(', ')}.${tail}`
  const a = linesAnswer(summary, [
    ['results', '', ok.map((r) => r.line)],
    ['failed', 'Failed:', failed],
  ])
  return ok.length === 0 && failed.length ? asError(a) : a
}

/** Records a failed entry, and when it means the rest would fail too, the entries not tried. */
function fail(failed, entries, i, text, e) {
  failed.push(text)
  if (!stops(e)) return false
  const rest = entries.slice(i + 1).map((x) => x.ref)
  if (rest.length) failed.push(`Not tried after that: ${rest.join(', ')}.`)
  return true
}

const fieldNamesOf = (b) => Object.fromEntries(FIELDS.map((k) => [k, b.fields[k].name]))

const notVisible = (ref) => `${unseen(ref)} Nothing added.`

/**
 * Adds an entry's issue or pull request to the project, for both writes. Answers null when this login
 * cannot see it. GitHub answering the add without the item it made is a failure (`added`: it may be on
 * the project all the same), never an item without an id.
 */
async function addToProject(b, e) {
  const content = await findContent(e.want.repo, e.want.number)
  if (!content) return null
  const itemId = await addContent(b.project.id, content.id)
  forget()
  if (!itemId) throw Object.assign(new GitHubError('github', `GitHub did not return the project item it added for ${e.ref}.`), { added: true })
  return { content, itemId }
}

// The two writes. Registered below; each runs inside oneAtATime.
async function setItemFields(args) {
  let b, entries
  try {
    b = await board({ fresh: true })
    entries = plan(b, args, { needFields: true })
  } catch (e) {
    return failure(e)
  }
  const items = b.items.map((i) => ({ ...i }))
  const rows = []
  const failed = []
  for (const [i, e] of entries.entries()) {
    let item = items.find(matches(e.want))
    let added = false
    if (!item) {
      try {
        const r = await addToProject(b, e)
        if (!r) {
          failed.push(notVisible(e.ref))
          continue
        }
        const { content, itemId } = r
        item = {
          itemId,
          type: content.type,
          number: content.number,
          title: content.title,
          url: content.url,
          state: null,
          draft: false,
          repository: e.want.repo,
          status: null,
          priority: null,
          area: null,
        }
        items.push(item)
        added = true
      } catch (err) {
        if (fail(failed, entries, i, `${e.ref}: ${reason(err)}`, err)) break
        continue
      }
    }
    const row = { itemId: item.itemId, options: e.options, fieldNames: fieldNamesOf(b) }
    try {
      const { done, same } = await writeFields(b, item, e.options)
      row.touched = done.length > 0
      row.line = done.length ? [`${e.ref}${added ? ' added' : ''} ${done.map(change).join(', ')}`, ...same].join('; ') : `${e.ref}${added ? ' added' : ''} unchanged: ${same.join(', ')}`
      rows.push(row)
    } catch (err) {
      if (fail(failed, entries, i, `${e.ref}: ${doneThen(err)}${reason(err)}`, err)) break
    }
  }
  const tail = await readBack(rows)
  const ok = rows.filter((r) => r.line)
  return writeAnswer(b, ok, [...count(ok.filter((r) => r.touched).length, 'changed'), ...count(ok.filter((r) => !r.touched).length, 'unchanged')], failed, tail)
}

async function addItem(args) {
  let b, entries
  try {
    b = await board({ fresh: true })
    entries = plan(b, args, { needFields: false })
  } catch (e) {
    return failure(e)
  }
  const rows = []
  const failed = []
  // One holder per project item, shared by every entry that names it: an item is added once, and a
  // later entry's "from" is what an earlier one set.
  const holders = new Map()
  let stopped = null
  // First every add, in order.
  for (const [i, e] of entries.entries()) {
    const key = `${e.want.repo.toLowerCase()}#${e.want.number}`
    const row = { options: e.options, fieldNames: fieldNamesOf(b), head: `${e.ref} already in the project` }
    let holder = holders.get(key)
    if (!holder) {
      const existing = b.items.find(matches(e.want))
      if (existing) holder = { itemId: existing.itemId, item: { ...existing } }
      else {
        try {
          const r = await addToProject(b, e)
          if (!r) {
            failed.push(notVisible(e.ref))
            continue
          }
          const { content, itemId } = r
          holder = { itemId, added: true }
          Object.assign(row, { added: true, touched: true, head: `${e.ref} added: ${content.title}${content.type === 'pull' ? ' (PR)' : ''}` })
        } catch (err) {
          if (fail(failed, entries, i, `${e.ref}: ${reason(err)}${err.added ? '' : ' Nothing added.'}`, err)) {
            stopped = 'its fields were not set after the failure above'
            break
          }
          continue
        }
      }
      holders.set(key, holder)
    }
    Object.assign(row, { holder, itemId: holder.itemId })
    rows.push(row)
  }
  // Then the fields, in the same order. A new item's current values come from GitHub, which may
  // list it only a moment later (findFresh), so every "from" is what GitHub had.
  const toSet = rows.filter((r) => Object.keys(r.options).length)
  const unlisted = [...new Set(toSet.map((r) => r.holder))].filter((h) => !h.item)
  if (!stopped && unlisted.length) {
    try {
      const { byId } = await findFresh(unlisted.map((h) => h.itemId))
      for (const h of unlisted) if (byId.has(h.itemId)) h.item = { ...byId.get(h.itemId) }
    } catch (err) {
      stopped = `reading the project back failed, so its fields were not set: ${reason(err)}`
    }
  }
  for (const r of toSet) {
    const why = stopped ?? (r.holder.item ? null : 'GitHub did not list it yet, so its fields were not set; set them with set_item_fields in a moment')
    if (why) {
      r.failed = true
      failed.push(`${r.head}; ${why}.`)
      continue
    }
    try {
      const { done, same } = await writeFields(b, r.holder.item, r.options)
      if (done.length) r.touched = true
      r.line = [r.head, ...(done.length ? [done.map(change).join(', ')] : []), ...same].join('; ')
    } catch (err) {
      r.failed = true
      failed.push(`${r.head}; ${doneThen(err)}${reason(err)}`)
      if (stops(err)) stopped = 'its fields were not set after the failure above'
    }
  }
  for (const r of rows) if (!r.line && !r.failed) r.line = r.added ? r.head : `${r.head}, nothing added`
  const tail = await readBack(rows)
  const ok = rows.filter((r) => r.line)
  return writeAnswer(b, ok, [...count(ok.filter((r) => r.added).length, 'added'), ...count(ok.filter((r) => !r.added).length, 'already in the project')], failed, tail)
}

export const tools = {
  list_items: {
    config: {
      title: 'List project items',
      description:
        'List the Centralu GitHub Project, one line per item: "#number title — Status · Priority · Area", in board order (decision column first, then by priority). The summary counts every Status. Filter by status, area, priority, or numbers (then in the order given).',
      inputSchema: z.object({
        status: z.string().optional().describe('Only this Status, for example "Ready"'),
        area: z.string().optional().describe('Only this Area, for example "UI"'),
        priority: z.string().optional().describe('Only this Priority: High, Medium or Low'),
        numbers: z.array(itemRef).max(100).optional().describe(`Only these items: each ${REF_HELP}`),
        detail: detailInput,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(async ({ status, area, priority, numbers, detail }) => {
      const b = await board()
      const want = {
        status: status === undefined ? null : resolveOption(b.fields.status, status).name,
        area: area === undefined ? null : resolveOption(b.fields.area, area).name,
        priority: priority === undefined ? null : resolveOption(b.fields.priority, priority).name,
      }
      const fits = (i) => (!want.status || i.status === want.status) && (!want.area || i.area === want.area) && (!want.priority || i.priority === want.priority)
      const filters = Object.entries(want).filter(([, v]) => v).map(([k, v]) => `${b.fields[k].name} ${v}`)
      const cols = want.status ? [want.status] : [...columns(b), ...(b.items.some((i) => !i.status) ? [null] : [])]
      let items
      let missing = []
      if (numbers !== undefined) {
        const picked = pick(b, numbers)
        items = picked.found.filter(fits)
        missing = picked.missing
        filters.push(`numbers ${numbers.join(', ')}`)
      } else {
        items = cols.flatMap((c) => b.items.filter((i) => i.status === c && fits(i)).sort(byPriority))
      }
      const counts = cols.map((c) => `${c ?? 'No status'} ${items.filter((i) => i.status === c).length}`)
      const summary = `${b.project.title}: ${items.length} of ${b.items.length} items${filters.length ? `, filtered by ${filters.join(', ')}` : ''}. ${counts.join(' · ')}.`
      return itemsAnswer(b, summary, items, detail, [['missing', 'Not in the project:', missing, true]])
    }),
  },

  get_items: {
    config: {
      title: 'Read specific items',
      description:
        'Read a few items by number, one line each in the order asked: "#number title — Status · Priority · Area". Says which are not in the project.',
      inputSchema: z.object({ items: z.array(itemRef).min(1).max(100).describe(`Each ${REF_HELP}`), detail: detailInput }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(async ({ items: inputs, detail }) => {
      const b = await board()
      const { found, missing } = pick(b, inputs)
      const summary = `${b.project.title}: ${found.length} of ${found.length + missing.length} in the project.`
      return itemsAnswer(b, summary, found, detail, [['missing', 'Not in the project:', missing, true]])
    }),
  },

  // Writes. Visible to agents and to the screen (the board's status menu and drag call this one), so
  // both go through the same code. Every answer names what changed on GitHub, then checks it.
  set_item_fields: {
    config: {
      title: 'Set Status, Priority or Area',
      description:
        'Set Status, Priority and/or Area on GitHub for one project item (item) or several (items, in order). Top-level status/priority/area apply to every entry without its own. Answers one line per item, e.g. "#297 Status Needs decision → Ready", then failures. A wrong option name changes nothing and lists the valid names.',
      inputSchema: z.object(batchInputs('set')),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { 'centralu/risk': 'routine' },
    },
    handler: serially(setItemFields),
  },

  add_item: {
    config: {
      title: 'Add issues or pull requests to the project',
      description:
        'Add one issue or pull request (item) or several (items, in order) to the Centralu GitHub Project, optionally setting Status, Priority and Area (top-level values apply to every entry without its own). One already in the project is not added twice. Answers one line per item, then failures.',
      inputSchema: z.object(batchInputs('added')),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { 'centralu/risk': 'routine', ui: { visibility: ['model'] } },
    },
    handler: serially(addItem),
  },
}
