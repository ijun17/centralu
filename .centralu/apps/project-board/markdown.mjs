// GitHub-flavoured Markdown to HTML for the board's reader (an issue's or pull request's body and
// comments, read in the view instead of the browser). Pure functions: no IO, no imports, so the
// app still starts with `node server.mjs` alone (AGENTS.md rule 1) and the tests call it directly.
//
// **Safe by construction, not by cleaning afterwards.** Every character of the input reaches the
// output either escaped as text or inside a tag this file writes itself, from a short list, with
// attributes it builds from checked values. Nothing from the input is ever passed through as
// markup: raw HTML is shown as text, except a few harmless tags GitHub also allows (`<br>`, `<b>`,
// `<details>`, `<img>` and the like), which are written anew from their parsed parts. The view sets
// the result with innerHTML, and its CSP still allows inline script (docs/apps.md §6.4), so this is
// the line that keeps `<img onerror>` or a `javascript:` link from running.
//
// Not the whole of GFM: headings, paragraphs (a single newline is a line break, as in GitHub's
// issues and comments), emphasis, strikethrough, code spans and fenced and indented code, links,
// autolinks, images, block quotes, nested and task lists, tables, rules, `#123` and `@name`.
// Reference-style links, footnotes and emoji shortcodes stay as written.

/** Tags this renderer writes, and the attributes each may carry. The tests hold every output to it. */
export const ALLOWED = {
  p: [],
  br: [],
  hr: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  strong: [],
  em: [],
  del: [],
  code: ['class'],
  pre: [],
  blockquote: [],
  ul: ['class'],
  ol: ['start'],
  li: ['class'],
  input: ['type', 'disabled', 'checked'],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['class'],
  td: ['class'],
  a: ['href', 'title', 'class', 'data-item'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'referrerpolicy'],
  details: ['open'],
  summary: [],
  sub: [],
  sup: [],
  kbd: [],
  b: [],
  i: [],
  s: [],
  ins: [],
  mark: [],
  small: [],
  u: [],
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
/** Text as HTML text or a double-quoted attribute value. */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c])

// Placeholders for finished HTML inside a line of text being worked on. Private-use characters the
// input cannot contain (they are replaced first), so no input can forge one.
const OPEN = ''
const CLOSE = ''
const SLOT = /(\d+)/g

/**
 * A link's address, absolute, or null when it is not one a person should be sent to: only http,
 * https and mailto. Resolved against the item's own address the way GitHub resolves a relative link.
 * The URL parser drops tabs and newlines first, so `java\tscript:` is caught here too.
 */
export function safeHref(raw, base) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  try {
    const u = base ? new URL(s, base) : new URL(s)
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null
  } catch {
    return null
  }
}

/**
 * An image the view may load: https on GitHub's own image hosts only, the ones the view's CSP
 * declares (view-tools.mjs VIEW_CSP). Anything else becomes a link, so the view never asks another
 * server for anything.
 */
export function imageSrc(raw) {
  try {
    const u = new URL(String(raw ?? '').trim())
    const host = u.hostname.toLowerCase()
    if (u.protocol === 'https:' && (host === 'github.com' || host.endsWith('.githubusercontent.com'))) return u.href
  } catch {}
  return null
}

// Sticky (`y`): tried at one position of the text, see `at` in renderInline
const HTML_ENTITY = /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/iy
const BACKTICKS = /`+/y
const AUTOLINK = /<((?:https?|mailto):[^\s<>]*)>/iy
const AUTOMAIL = /<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/y
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<]*/iy
const CROSS_REF = /([A-Za-z0-9][\w.-]*\/[\w.-]+)#(\d+)(?![\p{L}\p{N}_])/uy
const NUMBER_REF = /#(\d+)(?![\p{L}\p{N}_])/uy
const MENTION = /@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w/-])/y
const PUNCT = /[!-/:-@[-`{-~]/
// Inline HTML GitHub allows that carries no attributes worth keeping: written back as a bare tag.
const BARE_TAGS = new Set(['b', 'i', 'em', 'strong', 'sub', 'sup', 'kbd', 'code', 's', 'del', 'ins', 'mark', 'small', 'u'])
// Containers that only shape a README: their content is kept, the tag itself dropped.
const DROPPED_TAGS = new Set(['p', 'div', 'span', 'center', 'picture', 'source', 'font'])
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function attrsOf(text) {
  const out = {}
  for (const m of text.matchAll(ATTR)) out[m[1].toLowerCase()] = decodeBasic(m[2] ?? m[3] ?? m[4] ?? '')
  return out
}
const decodeBasic = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27);/gi, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e.toLowerCase()])

const dim = (v) => (/^\d{1,4}%?$/.test(String(v ?? '')) ? String(v) : null)

function imgTag(src, alt, title, extra = {}) {
  const ok = imageSrc(src)
  if (!ok) {
    const href = safeHref(src)
    const label = `Image${alt ? `: ${alt}` : ''}`
    return href ? `<a href="${esc(href)}" class="image-link">${esc(label)}</a>` : esc(`[${label}]`)
  }
  const size = ['width', 'height'].map((k) => (dim(extra[k]) ? ` ${k}="${esc(dim(extra[k]))}"` : '')).join('')
  return `<img src="${esc(ok)}" alt="${esc(alt ?? '')}"${title ? ` title="${esc(title)}"` : ''}${size} loading="lazy" referrerpolicy="no-referrer">`
}

// How long a link's text may be. A longer one is read as text.
const LINK_TEXT_MAX = 2000

/**
 * Where each `[` closes: its `]`, minding nesting and backslashes, in one pass over the text (a
 * search per `[` made 50,000 of them take a quarter of a second). Code spans are not looked into.
 */
function bracketPairs(text) {
  const pairs = new Map()
  const stack = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') i++
    else if (c === '[') stack.push(i)
    else if (c === ']' && stack.length) pairs.set(stack.pop(), i)
  }
  return pairs
}

/** `(dest "title")` right after a link's text, or null. Returns { dest, title, end }. */
function linkTail(text, at) {
  if (text[at] !== '(') return null
  let i = at + 1
  while (text[i] === ' ' || text[i] === '\n') i++
  let dest = ''
  if (text[i] === '<') {
    const end = text.indexOf('>', i)
    if (end < 0 || text.slice(i, end).includes('\n')) return null
    dest = text.slice(i + 1, end)
    i = end + 1
  } else {
    let depth = 0
    const start = i
    for (; i < text.length; i++) {
      const c = text[i]
      if (c === '\\' && PUNCT.test(text[i + 1] ?? '')) {
        i++
        continue
      }
      if (c === '(') depth++
      else if (c === ')') {
        if (depth === 0) break
        depth--
      } else if (/\s/.test(c)) break
    }
    dest = text.slice(start, i).replace(/\\([!-/:-@[-`{-~])/g, '$1')
  }
  while (text[i] === ' ' || text[i] === '\n') i++
  let title = null
  const q = text[i]
  if (q === '"' || q === "'" || q === '(') {
    const closer = q === '(' ? ')' : q
    const end = text.indexOf(closer, i + 1)
    if (end < 0 || end - i > 500) return null
    title = text.slice(i + 1, end)
    i = end + 1
    while (text[i] === ' ' || text[i] === '\n') i++
  }
  if (text[i] !== ')') return null
  return { dest, title, end: i + 1 }
}

/** Plain text of some inline Markdown, for an image's alt. */
const plain = (s) => s.replace(/[*_~`]/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')

/** GFM's extended autolink end: trailing punctuation and an unbalanced `)` are not part of it. */
function trimUrl(url) {
  let u = url.replace(/[?!.,:*_~'"]+$/, '')
  while (u.endsWith(')') && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) u = u.slice(0, -1).replace(/[?!.,:*_~'"]+$/, '')
  return u
}

/**
 * One run of inline Markdown (a paragraph, a heading, a table cell) as HTML. `ctx`: `repo`
 * (owner/name, for `#123`), `base` (the item's address, for relative links), `breaks` (a newline is
 * a line break), `noLinks` (inside a link's text).
 */
export function renderInline(text, ctx = {}) {
  // Spaces before a line's end say nothing more than the newline does (a newline already breaks)
  const src = String(text ?? '').replace(/[ \t]+\n/g, '\n')
  const slots = []
  const keep = (html) => `${OPEN}${slots.push(html) - 1}${CLOSE}`
  const open = [] // raw inline HTML tags opened and not yet closed, so each is closed in the end
  // The point after which no backtick run of a length closes: never searched again, so a text full
  // of unmatched backticks stays linear
  const noClose = new Map()
  let out = ''
  let i = 0
  /** A sticky expression tried at `i`, without copying the rest of the text (one copy per character was quadratic). */
  const at = (re) => ((re.lastIndex = i), re.exec(src))
  const wordBefore = () => i > 0 && /[\p{L}\p{N}_]/u.test(src[i - 1])
  let pairs = null
  const closeBracket = (open) => {
    pairs ??= bracketPairs(src)
    const end = pairs.get(open)
    return end !== undefined && end - open <= LINK_TEXT_MAX ? end : -1
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && PUNCT.test(src[i + 1] ?? '')) {
      out += keep(esc(src[i + 1]))
      i += 2
      continue
    }
    if (c === '\\' && src[i + 1] === '\n') {
      out += keep('<br>')
      i += 2
      continue
    }
    if (c === '\n') {
      out += ctx.breaks ? keep('<br>') + '\n' : '\n'
      i++
      while (src[i] === ' ') i++
      continue
    }
    if (c === '`') {
      const run = at(BACKTICKS)[0]
      let end = -1
      if (!(noClose.get(run.length) <= i)) {
        for (let from = i + run.length; from < src.length; ) {
          const found = src.indexOf('`', from)
          if (found < 0) break
          BACKTICKS.lastIndex = found
          const len = BACKTICKS.exec(src)[0].length
          if (len === run.length) {
            end = found
            break
          }
          from = found + len
        }
        if (end < 0) noClose.set(run.length, i)
      }
      if (end < 0) {
        out += keep(esc(run))
        i += run.length
        continue
      }
      let code = src.slice(i + run.length, end).replace(/\n/g, ' ')
      if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1)
      out += keep(`<code>${esc(code)}</code>`)
      i = end + run.length
      continue
    }
    if (c === '!' && src[i + 1] === '[') {
      const close = closeBracket(i + 1)
      const tail = close > 0 ? linkTail(src, close + 1) : null
      if (tail) {
        out += keep(imgTag(tail.dest, plain(src.slice(i + 2, close)), tail.title))
        i = tail.end
        continue
      }
    }
    if (c === '[' && !ctx.noLinks) {
      const close = closeBracket(i)
      const tail = close > 0 ? linkTail(src, close + 1) : null
      if (tail) {
        const href = safeHref(tail.dest, ctx.base)
        const inner = renderInline(src.slice(i + 1, close), { ...ctx, noLinks: true })
        out += keep(href ? `<a href="${esc(href)}"${tail.title ? ` title="${esc(tail.title)}"` : ''}>${inner}</a>` : inner)
        i = tail.end
        continue
      }
    }
    if (c === '<') {
      const auto = at(AUTOLINK) ?? at(AUTOMAIL)
      if (auto) {
        const href = safeHref(auto[1].includes(':') ? auto[1] : `mailto:${auto[1]}`)
        out += keep(href && !ctx.noLinks ? `<a href="${esc(href)}">${esc(auto[1])}</a>` : esc(auto[1]))
        i += auto[0].length
        continue
      }
      const tag = at(TAG)
      if (tag) {
        const [whole, closing, rawName, attrText] = tag
        const name = rawName.toLowerCase()
        let html = null
        if (name === 'br' && !closing) html = '<br>'
        else if (name === 'img' && !closing) {
          const a = attrsOf(attrText)
          html = imgTag(a.src, a.alt, a.title, a)
        } else if (name === 'a' && !ctx.noLinks) {
          if (!closing) {
            const href = safeHref(attrsOf(attrText).href, ctx.base)
            open.push('a')
            html = href ? `<a href="${esc(href)}">` : '<a>'
          } else if (open.includes('a')) {
            open.splice(open.lastIndexOf('a'), 1)
            html = '</a>'
          } else html = ''
        } else if (BARE_TAGS.has(name)) {
          if (!closing) {
            open.push(name)
            html = `<${name}>`
          } else if (open.includes(name)) {
            open.splice(open.lastIndexOf(name), 1)
            html = `</${name}>`
          } else html = ''
        } else if (DROPPED_TAGS.has(name)) html = ''
        if (html !== null) {
          out += keep(html)
          i += whole.length
          continue
        }
      }
      out += '&lt;'
      i++
      continue
    }
    if (c === '&') {
      const ent = at(HTML_ENTITY)
      // An entity stays one: the browser reads `&lt;` as a character, never as markup
      out += ent ? keep(ent[0]) : '&amp;'
      i += ent ? ent[0].length : 1
      continue
    }
    if (!ctx.noLinks && /[\p{L}\p{N}#@]/u.test(c) && !wordBefore()) {
      const url = at(BARE_URL)
      if (url) {
        const text = trimUrl(url[0])
        const www = /^www\./i.test(text)
        const href = safeHref(www ? `http://${text}` : text)
        if (href && text.length > (www ? 4 : 8)) {
          out += keep(`<a href="${esc(href)}">${esc(text)}</a>`)
          i += text.length
          continue
        }
      }
      const cross = at(CROSS_REF)
      if (cross) {
        out += keep(`<a href="https://github.com/${esc(cross[1])}/issues/${cross[2]}" class="ref" data-item="${esc(`${cross[1]}#${cross[2]}`)}">${esc(cross[0])}</a>`)
        i += cross[0].length
        continue
      }
      const num = ctx.repo ? at(NUMBER_REF) : null
      if (num) {
        out += keep(`<a href="https://github.com/${esc(ctx.repo)}/issues/${num[1]}" class="ref" data-item="${esc(`${ctx.repo}#${num[1]}`)}">#${num[1]}</a>`)
        i += num[0].length
        continue
      }
      const mention = at(MENTION)
      if (mention) {
        out += keep(`<a href="https://github.com/${esc(mention[1])}" class="mention">@${esc(mention[1])}</a>`)
        i += mention[0].length
        continue
      }
    }
    out += esc(c)
    i++
  }
  for (const name of open.reverse()) out += keep(`</${name}>`)
  return emphasis(out).replace(SLOT, (_, n) => slots[Number(n)])
}

/**
 * Strong, emphasis and strikethrough over text whose markup is already in placeholders. A span is
 * at most 2,000 characters, so an opener with no closer costs a bounded look ahead, not the rest of
 * a long comment each time.
 */
function emphasis(s) {
  return s
    .replace(/~~(?=\S)([\s\S]{0,2000}?\S)~~/g, '<del>$1</del>')
    .replace(/\*\*(?=[^\s*])([\s\S]{0,2000}?[^\s*])\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\p{L}\p{N}_])__(?=[^\s_])([\s\S]{0,2000}?[^\s_])__(?![\p{L}\p{N}_])/gu, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([^*]{0,2000}?[^\s*]|[^\s*])\*/g, '<em>$1</em>')
    .replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_]{0,2000}?[^\s_]|[^\s_])_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>')
}

// --- Blocks ---------------------------------------------------------------------------------------

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?/
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?=[ \t]|$)( {0,4})?/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const DETAILS_OPEN = /^ {0,3}<details(\s+open)?\s*>\s*(?:<summary>(.*?)<\/summary>)?\s*$/i
const DETAILS_CLOSE = /^ {0,3}<\/details\s*>\s*$/i
const SUMMARY = /^ {0,3}<summary>(.*?)<\/summary>\s*$/i

const blank = (l) => l === undefined || /^[ \t]*$/.test(l)

/** Table cells of one row, split on pipes that are not escaped. */
function cells(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const out = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (s[i] === '|') {
      out.push(cur.trim())
      cur = ''
    } else cur += s[i]
  }
  out.push(cur.trim())
  return out
}

/** Whether `lines[i]` starts a block that ends a paragraph. */
function interrupts(lines, i) {
  const l = lines[i]
  if (FENCE.test(l) || ATX.test(l) || HR.test(l) || QUOTE.test(l) || DETAILS_OPEN.test(l) || DETAILS_CLOSE.test(l)) return true
  const item = ITEM.exec(l)
  // An ordered list interrupts a paragraph only when it starts at 1, as in CommonMark
  if (item && !blank(l.slice(item[0].length)) && (!/\d/.test(item[2]) || /^1[.)]$/.test(item[2]))) return true
  return l.includes('|') && DELIMITER.test(lines[i + 1] ?? '') && lines[i + 1].includes('-') && cells(l).length === cells(lines[i + 1]).length
}

// Quotes and lists inside each other this deep are read as text: each level is a call deeper
const MAX_DEPTH = 16

function parseBlocks(lines, outer, tight = false) {
  const out = []
  let details = 0
  let i = 0
  const para = (html) => (tight ? html : `<p>${html}</p>`)
  const ctx = { ...outer, depth: (outer.depth ?? 0) + 1 }
  if (ctx.depth > MAX_DEPTH) return para(renderInline(lines.join('\n'), { ...ctx, breaks: true }))
  while (i < lines.length) {
    const line = lines[i]
    if (blank(line)) {
      i++
      continue
    }
    let m
    if ((m = FENCE.exec(line))) {
      const [, indent, fence, info] = m
      const body = []
      i++
      while (i < lines.length) {
        const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).exec(lines[i])
        if (close) {
          i++
          break
        }
        body.push(lines[i].replace(new RegExp(`^ {0,${indent.length}}`), ''))
        i++
      }
      const lang = /^[\w+#.-]{1,30}$/.test(info ?? '') ? ` class="language-${esc(info.toLowerCase())}"` : ''
      out.push(`<pre><code${lang}>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    if ((m = ATX.exec(line))) {
      const n = m[1].length
      out.push(`<h${n}>${renderInline(m[2] ?? '', { ...ctx, breaks: false })}</h${n}>`)
      i++
      continue
    }
    if (HR.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if ((m = DETAILS_OPEN.exec(line))) {
      details++
      out.push(`<details${m[1] ? ' open' : ''}>${m[2] !== undefined ? `<summary>${renderInline(m[2], { ...ctx, breaks: false })}</summary>` : ''}`)
      i++
      continue
    }
    if (DETAILS_CLOSE.test(line)) {
      if (details > 0) {
        details--
        out.push('</details>')
      }
      i++
      continue
    }
    if ((m = SUMMARY.exec(line))) {
      out.push(`<summary>${renderInline(m[1], { ...ctx, breaks: false })}</summary>`)
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const inner = []
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || (inner.length && !interrupts(lines, i)))) {
        inner.push(lines[i].replace(QUOTE, ''))
        i++
      }
      out.push(`<blockquote>${parseBlocks(inner, ctx)}</blockquote>`)
      continue
    }
    if (ITEM.test(line)) {
      const list = parseList(lines, i, ctx)
      out.push(list.html)
      i = list.end
      continue
    }
    if (line.includes('|') && DELIMITER.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      const head = cells(line)
      const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''))
      if (aligns.length === head.length) {
        const cell = (tag, text, n) => `<${tag}${aligns[n] ? ` class="align-${aligns[n]}"` : ''}>${renderInline(text, { ...ctx, breaks: false })}</${tag}>`
        const rows = []
        i += 2
        while (i < lines.length && !blank(lines[i]) && !(lines[i].trim() && interrupts(lines, i) && !lines[i].includes('|'))) {
          const row = cells(lines[i])
          rows.push(`<tr>${head.map((_, n) => cell('td', row[n] ?? '', n)).join('')}</tr>`)
          i++
        }
        out.push(`<table><thead><tr>${head.map((h, n) => cell('th', h, n)).join('')}</tr></thead>${rows.length ? `<tbody>${rows.join('')}</tbody>` : ''}</table>`)
        continue
      }
    }
    if (/^ {4}/.test(line)) {
      const body = []
      while (i < lines.length && (/^ {4}/.test(lines[i]) || blank(lines[i]))) {
        body.push(lines[i].slice(4))
        i++
      }
      while (body.length && blank(body.at(-1))) body.pop()
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    // A paragraph: lines up to a blank one or the start of another block
    const text = [line.trim()]
    i++
    let heading = 0
    while (i < lines.length && !blank(lines[i])) {
      const s = SETEXT.exec(lines[i])
      if (s) {
        heading = s[1][0] === '=' ? 1 : 2
        i++
        break
      }
      if (interrupts(lines, i)) break
      text.push(lines[i].replace(/^[ \t]+/, ''))
      i++
    }
    if (heading) out.push(`<h${heading}>${renderInline(text.join('\n'), { ...ctx, breaks: false })}</h${heading}>`)
    else out.push(para(renderInline(text.join('\n'), { ...ctx, breaks: ctx.breaks !== false })))
  }
  for (; details > 0; details--) out.push('</details>')
  return out.join('\n')
}

/** A list from `lines[start]`: its items, each parsed as blocks of its own. Returns { html, end }. */
function parseList(lines, start, ctx) {
  const first = ITEM.exec(lines[start])
  const ordered = /\d/.test(first[2])
  const items = []
  let i = start
  let loose = false
  while (i < lines.length) {
    const m = ITEM.exec(lines[i])
    if (!m || /\d/.test(m[2]) !== ordered) break
    const after = lines[i].slice(m[1].length + m[2].length)
    const spaces = /^[ \t]*/.exec(after)[0].length
    const width = m[1].length + m[2].length + (blank(after) ? 1 : spaces > 4 ? 1 : spaces)
    const body = [blank(after) ? '' : after.slice(Math.min(spaces, spaces > 4 ? 1 : spaces))]
    i++
    let sawBlank = false
    while (i < lines.length) {
      const l = lines[i]
      if (blank(l)) {
        body.push('')
        sawBlank = true
        i++
        continue
      }
      const indent = /^ */.exec(l)[0].length
      if (indent >= width) {
        body.push(l.slice(width))
        i++
        continue
      }
      if (!sawBlank && !ITEM.test(l) && !interrupts(lines, i)) {
        body.push(l.trim()) // a lazy continuation of the item's paragraph
        i++
        continue
      }
      break
    }
    // Blank lines at the item's end belong between items: they make the list loose only when another item follows
    let trailing = 0
    while (body.length && blank(body.at(-1))) (body.pop(), trailing++)
    if (body.slice(1).some(blank)) loose = true
    items.push(body)
    if (trailing) {
      const next = ITEM.exec(lines[i] ?? '')
      if (next && /\d/.test(next[2]) === ordered) loose = true
      else break
    }
  }
  const lis = items.map((body) => {
    const task = /^\[([ xX])\][ \t]+/.exec(body[0] ?? '')
    if (task) body = [body[0].slice(task[0].length), ...body.slice(1)]
    const html = parseBlocks(body, ctx, !loose)
    return task ? `<li class="task-item"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${html}</li>` : `<li>${html}</li>`
  })
  const startNo = ordered ? Number(/\d+/.exec(first[2])[0]) : 1
  const hasTasks = lis.some((l) => l.startsWith('<li class="task-item">'))
  const tag = ordered ? `<ol${startNo !== 1 ? ` start="${startNo}"` : ''}>` : `<ul${hasTasks ? ' class="tasks"' : ''}>`
  return { html: `${tag}${lis.join('')}</${ordered ? 'ol' : 'ul'}>`, end: i }
}

/**
 * HTML comments (`<!-- … -->`, the PR and issue templates are full of them) are removed outside
 * fenced code, as GitHub hides them.
 */
function stripComments(lines) {
  const out = []
  let fence = null
  let inComment = false
  for (const line of lines) {
    if (!inComment) {
      const f = /^[ >]*(`{3,}|~{3,})/.exec(line)
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
        out.push(line)
        continue
      }
      if (f) {
        fence = f[1]
        out.push(line)
        continue
      }
    }
    let rest = line
    let kept = ''
    for (;;) {
      if (inComment) {
        const end = rest.indexOf('-->')
        if (end < 0) {
          rest = ''
          break
        }
        rest = rest.slice(end + 3)
        inComment = false
      } else {
        const start = rest.indexOf('<!--')
        if (start < 0) break
        kept += rest.slice(0, start)
        rest = rest.slice(start + 4)
        inComment = true
      }
    }
    out.push(kept + rest)
  }
  return out
}

/**
 * Markdown to HTML. `opts.repo` ("owner/name") turns `#123` into a link that opens in the reader;
 * `opts.base` (the item's address) resolves relative links.
 */
export function renderMarkdown(source, opts = {}) {
  const text = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    // NUL and the placeholders' own characters cannot come from the input
    .replace(/[\0]/g, '�')
    .replace(/^\t+/gm, (t) => '    '.repeat(t.length))
  const ctx = { repo: opts.repo && /^[\w.-]+\/[\w.-]+$/.test(opts.repo) ? opts.repo : null, base: opts.base ? safeHref(opts.base) : null }
  return parseBlocks(stripComments(text.split('\n')), ctx)
}

// --- Decision summaries ---------------------------------------------------------------------------
// The coordinator agent leaves a comment on each item waiting on the owner:
//
//   ## Decision needed (summary, 2026-10-12)
//   **Question:** keep this as a separate staged improvement, or fold it into the v3 redesign?
//   **Options:** A. fold into #406/#403 · B. do the small parts now
//   **Recommendation:** A — #403 already carries the concrete proposal.
//
// and the owner answers with a comment that starts "Decision (owner, YYYY-MM-DD)" (CONTRIBUTING.md).

const SUMMARY_HEAD = /^\s*#{1,6}\s*Decision needed\s*\(summary(?:\s*,\s*([^)]*))?\)/i
const OWNER_DECISION = /^\s*(?:\*\*|__)?\s*Decision\s*\(owner\b/i
const FIELD = /^\s*(?:\*\*|__)\s*([A-Za-z][A-Za-z ]{0,30}?)\s*:\s*(?:\*\*|__)\s*(.*)$/

/**
 * The newest "Decision needed (summary, …)" comment's fields, from comments oldest first, or null.
 * `answered` is the date of an owner's "Decision (owner, …)" comment after it, if there is one.
 */
export function decisionSummary(comments) {
  const list = Array.isArray(comments) ? comments : []
  for (let n = list.length - 1; n >= 0; n--) {
    const body = String(list[n]?.body ?? '')
    const head = SUMMARY_HEAD.exec(body)
    if (!head) continue
    const fields = {}
    let key = null
    for (const line of body.split(/\r?\n/).slice(1)) {
      const f = FIELD.exec(line)
      if (f) {
        key = f[1].trim().toLowerCase()
        fields[key] = f[2].trim()
      } else if (key && line.trim() && !/^\s*#/.test(line)) fields[key] += `\n${line.trim()}`
      else key = null
    }
    const answer = list.slice(n + 1).find((c) => OWNER_DECISION.test(String(c?.body ?? '')))
    return {
      date: head[1]?.trim() || null,
      question: fields.question ?? null,
      options: fields.options ?? null,
      recommendation: fields.recommendation ?? null,
      url: list[n]?.url ?? null,
      answered: answer ? (answer.createdAt ?? true) : null,
    }
  }
  return null
}
