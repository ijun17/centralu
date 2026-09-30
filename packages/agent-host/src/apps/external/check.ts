import type { ReadResourceResult, Tool } from '@modelcontextprotocol/client'
import type { AppManifest } from './manifest.js'
import { toolNameError } from './manifest.js'
import { resourceUriOf, visibilityOf } from './visibility.js'

/**
 * App check (M4 C-3) — the judgment behind `check`, which the building session uses to test its
 * own app.
 *
 * A person must not end up being the tester (plan C-3). The building agent fixes something, calls
 * check on itself, reads what is wrong, and fixes it again. So the judgment looks at what the
 * **actually running app** says (its tool list, its screen resources) — it does not guess by
 * reading files. In spike S-6, even a broken server's process stayed alive: being up proves nothing.
 *
 * This file knows only the judgment and the wording. Starting the app and reading from it is the
 * runtime's door's job (`ExternalApps.check`).
 */

/** The MIME type of a screen resource — set by the MCP Apps spec. If it differs, the host will not render it as a screen. */
export const UI_MIME = 'text/html;profile=mcp-app'
/** The bridge placeholder in a template screen — `centralu.uiResource` replaces it. If it is still there, the screen has no bridge. */
const BRIDGE_TAG = 'centralu:mcp-app.js'

export type CheckLevel = 'problem' | 'warning'
export type CheckFinding = { level: CheckLevel; where: string; message: string }

/** The summary of one tool — one line of the report */
export type CheckedTool = { name: string; visibility: string[]; readOnly: boolean | null; screen: string | null }

export type AppCheckReport = {
  /** There are no problems at all (warnings are fine) */
  ok: boolean
  findings: CheckFinding[]
  tools: CheckedTool[]
  /** The screens that were read — uri and character count */
  screens: { uri: string; chars: number }[]
  /** The text for the building agent to read */
  text: string
}

const problem = (where: string, message: string): CheckFinding => ({ level: 'problem', where, message })
const warning = (where: string, message: string): CheckFinding => ({ level: 'warning', where, message })

/**
 * The judgment over a tool list. The `screens` it returns are the `ui://` resources the tools
 * point at — the runtime reads them one at a time and passes each to `checkScreen`.
 */
export function checkTools(manifest: AppManifest, tools: readonly Tool[]): { findings: CheckFinding[]; tools: CheckedTool[]; screens: string[] } {
  const findings: CheckFinding[] = []
  const summaries: CheckedTool[] = []
  const screens = new Set<string>()
  if (tools.length === 0) findings.push(warning('tool list', 'the app lists no tools — neither agents nor its screen have anything to call'))

  for (const t of tools) {
    const where = `tool ${t.name}`
    const nameError = toolNameError(t.name)
    if (nameError) findings.push(problem(where, `${nameError} — Centralu drops this tool, so nobody can call it`))
    const vis = visibilityOf(t)
    if (!vis.ok) findings.push(problem(where, `${vis.error} — Centralu drops this tool`))
    else if (vis.visibility.length === 0) findings.push(warning(where, '_meta.ui.visibility is an empty list, so neither agents nor the screen can call it'))

    const ann = t.annotations
    const readOnly = typeof ann?.readOnlyHint === 'boolean' ? ann.readOnlyHint : null
    if (readOnly === null) {
      findings.push(
        problem(
          where,
          'annotations.readOnlyHint is missing — write `readOnlyHint: true` if the tool only reads, `readOnlyHint: false` if it changes anything. ' +
            "Without it the tool counts as one that changes things: a session asks before every call, Codex's auto preset does not call it, " +
            "and every call makes all of this app's open screens read again",
        ),
      )
    } else if (readOnly && ann?.destructiveHint === true) {
      findings.push(warning(where, 'readOnlyHint: true together with destructiveHint: true — one of them is wrong'))
    }
    if (!t.description?.trim()) findings.push(warning(where, 'no description — agents pick a tool by reading its description'))

    // The same judgment as the side that opens the fixed screen (`homeView`) — the screen must not
    // reject a declaration the check has already passed
    const ui = resourceUriOf(t)
    if (ui.error) findings.push(problem(where, `${ui.error} — it will not open as a screen`))
    if (ui.uri) screens.add(ui.uri)
    summaries.push({ name: t.name, visibility: vis.ok ? vis.visibility : [], readOnly, screen: ui.uri })
  }

  if (manifest.home) {
    const where = `home (${manifest.home})`
    const home = tools.find((t) => t.name === manifest.home)
    if (!home) {
      findings.push(problem(where, 'the tool centralu.app.json names as home is not in the tool list — the app cannot be opened from the sidebar'))
    } else {
      if (resourceUriOf(home).uri === null) {
        findings.push(problem(where, 'the home tool has no screen — add `_meta: { ui: { resourceUri: "ui://…" } }` and register that resource with `centralu.uiResource`'))
      }
      const vis = visibilityOf(home)
      if (vis.ok && !vis.visibility.includes('app')) {
        findings.push(problem(where, `the home tool is not open to the screen (visibility: ${JSON.stringify(vis.visibility)}) — when the app opens, Centralu calls home from the screen's side`))
      }
    }
  }
  return { findings, tools: summaries, screens: [...screens] }
}

/** The judgment over one screen resource — either the result it read or the error reading it hit */
export function checkScreen(uri: string, read: ReadResourceResult | Error): { findings: CheckFinding[]; chars: number } {
  const where = `screen ${uri}`
  if (read instanceof Error) return { findings: [problem(where, `could not be read: ${read.message.split('\n')[0]}`)], chars: 0 }
  const content = read.contents.find((c) => c.uri === uri) ?? read.contents[0]
  if (!content) return { findings: [problem(where, 'it was read but came back empty (no contents)')], chars: 0 }
  const findings: CheckFinding[] = []
  if (content.mimeType !== UI_MIME) {
    findings.push(problem(where, `its mimeType is ${JSON.stringify(content.mimeType ?? null)} — a screen must be "${UI_MIME}" (centralu.uiResource sets it)`))
  }
  const text = 'text' in content && typeof content.text === 'string' ? content.text : null
  if (text === null) {
    findings.push(warning(where, "the HTML came as a blob, not as text — Centralu's template sends text"))
    return { findings, chars: 0 }
  }
  if (!text.trim()) findings.push(problem(where, 'the HTML is empty'))
  if (text.includes(BRIDGE_TAG)) {
    findings.push(problem(where, `<script src="${BRIDGE_TAG}"> is still in the page — this screen has no bridge, so it cannot call tools. Register it with centralu.uiResource`))
  }
  return { findings, chars: text.length }
}

/** The report's wording — written so the building agent can read it and fix things: the problem first, where, and what to do */
export function formatReport(
  label: string,
  r: Omit<AppCheckReport, 'text' | 'ok'>,
  context: { process: string | null; notes: string[]; stderr: string | null },
): AppCheckReport {
  const problems = r.findings.filter((f) => f.level === 'problem')
  const warnings = r.findings.filter((f) => f.level === 'warning')
  const ok = problems.length === 0
  const lines: string[] = []
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`
  lines.push(
    ok
      ? `check ${label}: passed${warnings.length ? ` (${count(warnings.length, 'warning')})` : ''}`
      : `check ${label}: ${count(problems.length, 'problem')}${warnings.length ? `, ${count(warnings.length, 'warning')}` : ''} — fix them, then call check again`,
  )
  for (const f of [...problems, ...warnings]) lines.push(`- ${f.level} [${f.where}] ${f.message}`)
  for (const n of context.notes) lines.push(`- note: ${n}`)
  if (r.tools.length) {
    lines.push('Tools:')
    for (const t of r.tools) {
      const kind = t.readOnly === true ? 'reads' : t.readOnly === false ? 'changes' : 'no readOnlyHint'
      const who = t.visibility.join('+') || 'nobody'
      lines.push(`  ${t.name} — ${kind}, ${who}${t.screen ? `, screen ${t.screen}` : ''}`)
    }
  }
  for (const s of r.screens) lines.push(`Screen ${s.uri}: ${count(s.chars, 'character')}`)
  if (context.process) lines.push(`Process: ${context.process}`)
  if (!ok && context.stderr) lines.push(`The app's stderr (last lines):\n${context.stderr}`)
  return { ok, ...r, text: lines.join('\n') }
}
