/**
 * Readers the adapters' `surface.read` share (#270): a CLI's `--help`, and the type declarations a vendor ships. Text
 * in, names out, no IO: the drift run gathers the text, and the tests feed recorded copies.
 *
 * The declarations are read by their text, not with the TypeScript compiler, because the host bundle carries these
 * readers and must not carry a compiler. That holds while the files are what `tsc` emits (one member per `;`, doc
 * comments in block comments), which is what the vendors ship. A shape these readers no longer understand throws rather than
 * reading as an empty surface: an empty read would report every name as gone.
 */

/**
 * The flags and subcommands a `--help` lists, as `flag:--name` and `subcommand:name`.
 *
 * Both CLIs print an `Options:` and a `Commands:` section (commander and clap). A flag line is indented a little and
 * starts with `-`; the description runs on from a deeper indent and can itself start with a flag it mentions (Claude's
 * `--bare` lists `--append-system-prompt[-file], --add-dir` on a line of its own), so the indent tells them apart. A
 * command line is indented by two. `--help`, `--version` and `help` are every CLI's and say nothing.
 */
export function helpSurface(help: string): string[] {
  const out = new Set<string>()
  let section = ''
  for (const raw of help.split(/\r?\n/)) {
    const heading = /^([A-Z][A-Za-z ]*):\s*$/.exec(raw)
    if (heading) {
      section = heading[1]!.toLowerCase()
      continue
    }
    const indent = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (!text) continue
    if (section === 'options' && indent <= 8 && text.startsWith('-')) {
      const head = text.split(/\s{2,}/)[0]!
      for (const m of head.matchAll(/--[A-Za-z0-9][\w-]*/g)) {
        if (m[0] !== '--help' && m[0] !== '--version') out.add(`flag:${m[0]}`)
      }
    } else if (section === 'commands' && indent === 2) {
      for (const name of text.split(/\s/)[0]!.split('|')) {
        if (/^[a-z][\w-]*$/.test(name) && name !== 'help') out.add(`subcommand:${name}`)
      }
    }
  }
  if (out.size === 0) throw new Error('--help listed no options or commands: did its format change?')
  return [...out].sort()
}

const IDENT = /^[A-Za-z_$][\w$]*$/

/** The text without its comments: a doc comment can hold any bracket or quote, and only declarations are read */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Splits at `sep` where no bracket or string is open */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if ('{[(<'.includes(c)) depth++
    else if ('}])>'.includes(c) && !(c === '>' && text[i - 1] === '=')) depth--
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** From an opening bracket at `open`, the text up to its matching close */
function enclosed(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]!
    if ('{[(<'.includes(c)) depth++
    else if ('}])>'.includes(c) && !(c === '>' && text[i - 1] === '=')) {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  throw new Error('an unclosed bracket')
}

/**
 * Type declarations by name: `[export] declare type X = …;` (the right-hand side) and `[export] [declare] interface X
 * [extends …] { … }` (the body, in braces).
 */
export class Declarations {
  private readonly text: string

  constructor(dts: string) {
    this.text = stripComments(dts)
  }

  /** The right-hand side of a type alias, or the braced body of an interface; null when not declared */
  find(name: string): string | null {
    const alias = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+${name}\\s*(?:<[^=]*>)?\\s*=\\s*`).exec(this.text)
    if (alias) {
      const from = alias.index + alias[0].length
      let depth = 0
      for (let i = from; i < this.text.length; i++) {
        const c = this.text[i]!
        if ('{[(<'.includes(c)) depth++
        else if ('}])>'.includes(c) && !(c === '>' && this.text[i - 1] === '=')) depth--
        else if (c === ';' && depth === 0) return this.text.slice(from, i).trim()
      }
      throw new Error(`the declaration of ${name} does not end`)
    }
    const iface = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+${name}\\b[^{]*\\{`).exec(this.text)
    if (iface) return `{${enclosed(this.text, iface.index + iface[0].length - 1)}}`
    return null
  }

  /** `find`, or a throw naming what is missing */
  get(name: string): string {
    const found = this.find(name)
    if (found === null) throw new Error(`${name} is not declared`)
    return found
  }

  /** The member names of an object type or interface (`{ a: …; b?(): … }` gives a, b) */
  members(name: string): string[] {
    return membersOf(this.get(name), name)
  }

  /**
   * The object types a union stands for, through aliases (`A | ns.B`, `A = C | D`) and intersections (`X & { … }`).
   * A member that is neither an object type nor a declared name is an error: a reader cannot tell what it carries.
   */
  objectsOf(name: string, seen = new Set<string>()): string[] {
    if (seen.has(name)) return []
    seen.add(name)
    const out: string[] = []
    for (const part of splitTop(this.get(name), '|')) out.push(...this.objectsOfType(part, seen))
    return out
  }

  private objectsOfType(type: string, seen: Set<string>): string[] {
    const t = type.trim()
    if (t.startsWith('{')) return [t]
    const and = splitTop(t, '&')
    if (and.length > 1) return and.flatMap((p) => this.objectsOfType(p, seen))
    const ref = t.replace(/^\w+\./, '')
    if (IDENT.test(ref)) return this.objectsOf(ref, seen)
    throw new Error(`cannot read the union member ${t}`)
  }
}

/** The member names of an object type's text */
export function membersOf(body: string, label = 'a type'): string[] {
  const t = body.trim()
  if (!t.startsWith('{')) throw new Error(`${label} is not an object type`)
  const out: string[] = []
  for (const m of splitTop(enclosed(t, 0), ';')) {
    const name = /^(?:readonly\s+)?([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")\??\s*[:(<]/.exec(m)?.[1]
    if (name) out.push(name.replace(/^['"]|['"]$/g, ''))
  }
  return out
}

/** The string literals a member of an object type allows (`type: 'a'` gives a, `subtype: 'b' | 'c'` gives b, c) */
export function literalsOf(object: string, member: string): string[] {
  const t = object.trim()
  for (const m of splitTop(enclosed(t, 0), ';')) {
    const hit = new RegExp(`^(?:readonly\\s+)?${member}\\??\\s*:\\s*([\\s\\S]*)$`).exec(m)
    if (!hit) continue
    return splitTop(hit[1]!, '|').flatMap((v) => {
      const lit = /^'([^']*)'$|^"([^"]*)"$/.exec(v.trim())
      return lit ? [lit[1] ?? lit[2]!] : []
    })
  }
  return []
}

/** The `"method": "…"` names of a generated JSON-RPC union (ts-rs output: `{ "method": "x", … } | …`) */
export function methodsOf(source: string, label: string): string[] {
  const out = [...new Set([...source.matchAll(/"method":\s*"([^"]+)"/g)].map((m) => m[1]!))].sort()
  if (out.length === 0) throw new Error(`${label} declares no methods: did the generated shape change?`)
  return out
}
