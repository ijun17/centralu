/** The field names of a generated Codex type, read by `pnpm codex:bindings` to hold the contract to what Codex makes (#2513) */

const withoutComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '')

/** The fields of the object that begins at `open` (a `{`), up to its matching `}`; a quoted key such as the `"type"` tag is not a field */
function objectFields(src: string, open: number): { name: string; required: boolean }[] {
  const fields: { name: string; required: boolean }[] = []
  let depth = 0
  let start = open + 1
  const push = (end: number): void => {
    const m = /^\s*(\w+)(\??)\s*:/.exec(src.slice(start, end))
    if (m) fields.push({ name: m[1]!, required: m[2] !== '?' })
  }
  for (let i = open; i < src.length; i++) {
    const c = src[i]!
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
export function paramFields(src: string): { name: string; required: boolean }[] | null {
  const text = withoutComments(src)
  const open = text.indexOf('= {')
  return open < 0 ? null : objectFields(text, open + 2)
}

/** The fields of the variant tagged `"type": "<tag>"` in a union (`ThreadItem`), wherever it sits (a plain union or inside an intersection); null when there is none */
export function variantFields(src: string, tag: string): { name: string; required: boolean }[] | null {
  const text = withoutComments(src)
  const m = new RegExp(`\\{\\s*"type":\\s*"${tag}"`).exec(text)
  return m ? objectFields(text, m.index) : null
}
