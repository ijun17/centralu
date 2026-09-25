import type { ReadResourceResult, Tool } from '@modelcontextprotocol/client'
import type { AppManifest } from './manifest.js'
import { toolNameError } from './manifest.js'
import { resourceUriOf, visibilityOf } from './visibility.js'

/**
 * 앱 점검 (M4 C-3) — 만드는 세션이 자기 앱을 시험하는 `check`의 판정.
 *
 * 사람이 시험 담당이 되면 안 된다(플랜 C-3). 만드는 에이전트가 고친 뒤 스스로 부르고, 무엇이 틀렸는지 읽고,
 * 다시 고친다. 그래서 판정은 **실제로 띄운 앱**이 말한 것(도구 목록, 화면 리소스)을 본다 — 파일을 읽어
 * 짐작하지 않는다. 스파이크 S-6에서 깨진 서버도 프로세스는 살아 있었다: 떠 있는 것은 아무것도 증명하지 않는다.
 *
 * 이 파일은 판정과 글만 안다. 앱을 띄우고 읽는 일은 런타임의 문(`ExternalApps.check`)이 한다.
 */

/** 화면 리소스의 MIME — MCP Apps 규격이 정한다. 다르면 호스트가 화면으로 그리지 않는다 */
export const UI_MIME = 'text/html;profile=mcp-app'
/** 템플릿 화면의 브리지 자리표시 — `centralu.uiResource`가 갈아 끼운다. 남아 있으면 화면에 브리지가 없다 */
const BRIDGE_TAG = 'centralu:mcp-app.js'

export type CheckLevel = 'problem' | 'warning'
export type CheckFinding = { level: CheckLevel; where: string; message: string }

/** 도구 하나의 요약 — 보고서의 한 줄 */
export type CheckedTool = { name: string; visibility: string[]; readOnly: boolean | null; screen: string | null }

export type AppCheckReport = {
  /** 문제가 하나도 없다 (주의는 있어도 된다) */
  ok: boolean
  findings: CheckFinding[]
  tools: CheckedTool[]
  /** 읽어 본 화면 — uri와 글자 수 */
  screens: { uri: string; chars: number }[]
  /** 만드는 에이전트가 읽을 글 */
  text: string
}

const problem = (where: string, message: string): CheckFinding => ({ level: 'problem', where, message })
const warning = (where: string, message: string): CheckFinding => ({ level: 'warning', where, message })

/**
 * 도구 목록의 판정. 돌려주는 `screens`는 도구들이 가리키는 `ui://` 리소스 — 런타임이 하나씩 읽어 `checkScreen`에 넘긴다.
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

    // 고정 화면을 여는 쪽(`homeView`)과 같은 판정이다 — 점검이 통과시킨 선언을 화면이 거절하면 안 된다
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

/** 화면 리소스 하나의 판정 — 읽은 결과 또는 읽다 난 오류 */
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

/** 보고서의 글 — 만드는 에이전트가 읽고 고칠 수 있게: 문제가 먼저, 어디서, 무엇을 할지 */
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
