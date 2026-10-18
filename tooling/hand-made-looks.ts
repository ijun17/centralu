/**
 * Finds the places that draw a shared component's look by hand (tooling/shared-components.test.ts).
 *
 * A look is read from the classes an element is given, so a class string assembled at the call site
 * is found however the JSX around it is laid out: every string and template literal inside the
 * `className` expression counts, and so does a `const` of the same file that the expression names
 * (`const pill = 'rounded-full border …'` then `className={pill}`). Only whole tokens match, and only the
 * resting look counts: a class behind a variant (`hover:border`, `disabled:…`) is left out.
 *
 * The looks, and why each is the one that names its component:
 *
 * - `button`: a `<button>` whose classes hold `border` and a `rounded…` radius. A framed text
 *   button is `Button`; an unframed one (an icon, a link-like word, a row) is not this look.
 * - `input`: an `<input>` with `border` of its own, unless its literal `type` is not text (a colour swatch, a
 *   checkbox). A framed text field is `TextInput` or `TextField`; an input that
 *   sits inside a frame drawn by its parent (the search boxes, the composer) has no border itself.
 * - `badge`: any element with both `uppercase` and `text-2xs`, the small caps label that is `Badge`.
 * - `capsule`: any element with both `rounded-full` and `border`, the capsule that is `Pill`.
 */
import ts from 'typescript'

export type Look = 'button' | 'input' | 'badge' | 'capsule'

export interface Site {
  look: Look
  line: number
  tag: string
}

/** A class that applies only in a state or a breakpoint (`hover:border`) */
const behindVariant = (token: string) => token.includes(':')

/** Every literal text inside an expression, following identifiers to the file's own consts */
function literals(node: ts.Node, consts: Map<string, ts.Expression>, seen = new Set<string>()): string[] {
  const out: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text)
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text)
      for (const span of n.templateSpans) {
        visit(span.expression)
        out.push(span.literal.text)
      }
      return
    } else if (ts.isIdentifier(n) && consts.has(n.text) && !seen.has(n.text)) {
      seen.add(n.text)
      out.push(...literals(consts.get(n.text)!, consts, seen))
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/** Inputs that are not a text field: a swatch, a box to tick, a slider. TextInput is not their look */
const NOT_TEXT = new Set(['checkbox', 'radio', 'color', 'range', 'file', 'hidden'])

function lookOf(tag: string, tokens: Set<string>, inputType: string | null): Look[] {
  const looks: Look[] = []
  const rounded = [...tokens].some((t) => t === 'rounded' || t.startsWith('rounded-'))
  if (tag === 'button' && tokens.has('border') && rounded) looks.push('button')
  if (tag === 'input' && tokens.has('border') && !(inputType && NOT_TEXT.has(inputType))) looks.push('input')
  if (tokens.has('uppercase') && tokens.has('text-2xs')) looks.push('badge')
  if (tokens.has('rounded-full') && tokens.has('border')) looks.push('capsule')
  return looks
}

/** The hand-made looks in one `.tsx` source */
export function scan(source: string, fileName = 'file.tsx'): Site[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const consts = new Map<string, ts.Expression>()
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer)
    ts.forEachChild(n, collect)
  }
  collect(sf)
  const sites: Site[] = []
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf)
      // A literal `type="color"`; a type chosen at run time counts as a text field
      const typeAttr = n.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'type')
      const inputType =
        typeAttr && ts.isJsxAttribute(typeAttr) && typeAttr.initializer && ts.isStringLiteral(typeAttr.initializer)
          ? typeAttr.initializer.text
          : null
      for (const attr of n.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== 'className' || !attr.initializer) continue
        const tokens = new Set(
          literals(attr.initializer, consts)
            .join(' ')
            .split(/\s+/)
            .filter(Boolean)
            .filter((t) => !behindVariant(t)),
        )
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
        for (const look of lookOf(tag, tokens, inputType)) sites.push({ look, line, tag })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return sites
}
