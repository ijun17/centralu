/** The field names of a generated Codex type, read by `pnpm codex:bindings` to hold the contract to what Codex makes (#2513) */

type Field = { name: string; required: boolean }

// `=>` would close an object at its `>`
const cleaned = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/=>/g, '~~')

/** The fields of the object that begins at `open` (a `{`), up to its matching `}`; a quoted key such as the `"type"` tag is not a field */
function objectFields(src: string, open: number): Field[] {
  const fields: Field[] = []
  let depth = 0
  let start = open + 1
  const push = (end: number): void => {
    const m = /^\s*(\w+)(\??)\s*:/.exec(src.slice(start, end))
    if (m?.[1]) fields.push({ name: m[1], required: m[2] !== '?' })
  }
  for (let i = open; i < src.length; i++) {
    const c = src.charAt(i)
    if ('{[(<'.includes(c)) depth++
    else if ('}])>'.includes(c)) {
      depth--
      if (depth === 0) {
        push(i)
        return fields
      }
    } else if (c === ',' && depth === 1) {
      push(i)
      start = i + 1
    }
  }
  return fields
}

/** The fields of a params or response type, which is one object: `export type X = { a: T, b?: U }`; null when it is not */
export function paramFields(src: string): Field[] | null {
  const text = cleaned(src)
  const open = text.indexOf('= {')
  return open < 0 ? null : objectFields(text, open + 2)
}

/**
 * The fields of the variant tagged `"type": "<tag>"` in a union (`ThreadItem`), in a plain union or inside an intersection;
 * null when there is none, or when the variant only names another type (`{ "type": "x" } & Item`), which is not read here.
 * An object nested in another one is not a variant: only one at the union's own level counts.
 */
export function variantFields(src: string, tag: string): Field[] | null {
  const text = cleaned(src)
  const tagged = new RegExp(`\\{\\s*"type":\\s*"${tag.replace(/[^\w/.-]/g, '')}"\\s*,`, 'g')
  const from = Math.max(0, text.indexOf('= '))
  for (const m of text.matchAll(tagged)) {
    // What the object sits in: nothing (a plain union) or the intersection's parentheses; inside another object it is nested
    const open: string[] = []
    for (const c of text.slice(from, m.index)) {
      if ('{[(<'.includes(c)) open.push(c)
      else if ('}])>'.includes(c)) open.pop()
    }
    if (open.length === 0 || open[open.length - 1] === '(') return objectFields(text, m.index)
  }
  return null
}
