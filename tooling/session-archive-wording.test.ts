/**
 * The session archive is never called "trash" in words a person or an agent reads (#1404).
 *
 * The owner asked an orchestrator to "empty the trash" on a linked Windows machine and meant the Windows Recycle
 * Bin. The orchestrator read it as Centralu's session trash and permanently deleted 108 session records. What
 * Centralu keeps there is not rubbish: it is finished sessions put away, which can be opened again, so the concept is
 * the session archive (docs/domain-model.md). The word "trash" stays only where it names something else (the
 * operating system's bin that the desktop shell moves a file or a folder to) or where the protocol and the store keep
 * the old name because they only grow (`trash.*` methods, the `sessions.trash` column).
 *
 * This reads every string, template and piece of JSX text in the UI, the platform (the mock's errors reach the screen), the protocol and the host (tests and test helpers
 * excluded), so a comment can say what an identifier used to be called, but a screen, a tool result or a prompt cannot.
 * Fix a failure by wording it as the archive. Add to `ALLOWED` only for a text that is about the operating system's
 * bin, with the reason; a stale entry fails too, so the list cannot grow quietly.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Where a person or an agent reads what the code says */
const SCANNED = ['packages/ui/src', 'packages/platform/src', 'packages/protocol/src', 'packages/agent-host/src']

/** `text` matches the part of a text that is allowed to say trash; the rest of the text is still checked */
type Allowed = { file: RegExp; text: RegExp; why: string }

const ALLOWED: Allowed[] = [
  // The operating system's bin, for a file or a folder the desktop shell moves there
  { file: /ui\/src\/features\/files\/FileTree\.tsx$/, text: /\bto (the )?Trash\b/g, why: 'the OS bin that "Move to Trash" in the file tree uses' },
  { file: /ui\/src\/features\/project\/DeleteProjectDialog\.tsx$/, text: /The folder itself goes to the Trash|Move the folder to the Trash too|Delete and trash folder|folder goes to this computer's trash/g, why: 'the OS bin the project folder can be moved to' },
  { file: /ui\/src\/features\/settings\/ThemeSection\.tsx$/, text: /theme to the trash/g, why: 'the OS bin a theme file is moved to' },
  { file: /platform\/src\/web\/index\.ts$/, text: /A browser has no trash/g, why: 'the OS bin a file is moved to, which a browser lacks' },
  { file: /platform\/src\/tauri\/index\.ts$/, text: /^trash_path$/g, why: 'the name of the shell command that moves a file to the OS bin' },
  { file: /(platform\/src\/web\/index|agent-host\/src\/dev-services\/project-files)\.ts$/, text: /^trash$/g, why: 'the `fs.resolve` purpose "trash": the entry that goes to the OS bin' },
  { file: /./, text: /\bapp-trash\b/g, why: 'the folder on disk where a removed app is kept' },
  // Names the protocol and the store keep because they only grow
  { file: /./, text: /^(trash\.\w+|subagents\.trash|messages\.subagentTrashed)$/g, why: 'protocol method names' },
  { file: /agent-host\/src\/dev-services\/store\//, text: /\b(?:[a-z]\.)?trash\b(?=[),]| =| TEXT| FROM| (?:as|AS)\b)|\btrashed_at\b|\b(?:as|AS) trashed?\b|^trash$|\bsubagent_messages_trash\b/g, why: 'SQL on the `sessions.trash` and `subagent_messages.trashed_at` columns' },
  { file: /protocol\/src\/commands\/files\.ts$/, text: /^trash$/g, why: 'the `fs.resolve` purpose "trash": the entry that goes to the OS bin' },
]

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sources(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/test-helpers\.tsx?$/.test(name) ? [p] : []
  })
}

function ancestors(node: ts.Node): ts.Node[] {
  return node.parent ? [node.parent, ...ancestors(node.parent)] : []
}

/** The words the code says: strings, templates and JSX text. Not comments, identifiers, imports or test ids. */
function wordsIn(code: string, file: string): { text: string; line: number }[] {
  const src = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: { text: string; line: number }[] = []
  const visit = (node: ts.Node) => {
    const isText =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    if (isText) {
      const parent = node.parent
      const module = parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent) || ts.isImportTypeNode(parent))
      const testId = ancestors(node).some((a) => ts.isJsxAttribute(a) && /test-?id/i.test(a.name.getText(src)))
      if (!module && !testId) found.push({ text: node.text, line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}

const words = (file: string) => wordsIn(readFileSync(file, 'utf8'), file)

const used = new Set<Allowed>()

/** Whether a text of this file still says trash once the allowed parts (the OS bin, the storage names) are taken out */
function flagged(rel: string, text: string): boolean {
  let rest = text
  for (const a of ALLOWED) {
    if (!a.file.test(rel)) continue
    const left = rest.replace(a.text, '')
    if (left !== rest) used.add(a)
    rest = left
  }
  return /trash/i.test(rest)
}

const hits = SCANNED.flatMap((dir) => sources(join(ROOT, dir))).flatMap((file) => {
  const rel = relative(ROOT, file).split(sep).join('/')
  return words(file)
    .filter((w) => flagged(rel, w.text))
    .map((w) => `${rel}:${w.line}: ${w.text.replace(/\s+/g, ' ').trim().slice(0, 100)}`)
})

describe('the session archive is not called the trash in UI copy or agent-facing text', () => {
  it('says "archive" in every string, template and JSX text of the UI and the host', () => {
    expect(hits).toEqual([])
  })

  it('keeps an allowlist in which every entry still matches something', () => {
    // An entry for a text that was reworded would let the old word back in unnoticed
    expect(ALLOWED.filter((a) => !used.has(a)).map((a) => `${a.file}: ${a.text}`)).toEqual([])
  })

  it('reads the texts at all', () => {
    // A guard whose reader found nothing would pass forever
    const lines = words(join(ROOT, 'packages/ui/src/features/settings/ArchiveSection.tsx')).map((w) => w.text)
    expect(lines.some((t) => /Delete all archived sessions/.test(t))).toBe(true)
  })

  it('lets an allowed part through but not the rest of the same text', () => {
    const file = 'packages/agent-host/src/apps/external/x.ts'
    expect(flagged(file, 'its folder is in app-trash/')).toBe(false)
    expect(flagged(file, 'its folder is in app-trash/, not in the trash')).toBe(true)
    expect(flagged('packages/agent-host/src/dev-services/store/x.ts', 'UPDATE sessions SET trash = ? WHERE id = ?')).toBe(false)
    expect(flagged('packages/agent-host/src/dev-services/store/x.ts', 'UPDATE sessions SET trash = ? -- the trash')).toBe(true)
  })

  it('finds the word in a string, a template, JSX text and a JSX attribute, not in a comment or a test id', () => {
    const count = (code: string) => wordsIn(code, 'probe.tsx').filter((w) => /trash/i.test(w.text)).length
    expect(count(`const a = 'Moved to the trash'`)).toBe(1)
    expect(count('const a = `${x} went to the trash`')).toBe(1)
    expect(count(`const a = <p>Empty trash…</p>`)).toBe(1)
    expect(count(`const a = <button title="Move to trash" />`)).toBe(1)
    expect(count(`// the trash
const a = 1`)).toBe(0)
    expect(count(`const a = <i data-testid="trash-list" />`)).toBe(0)
    expect(count('const a = <i data-testid={`trash-row-${id}`} />')).toBe(0)
  })
})
