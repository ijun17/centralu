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
  if (tools.length === 0) findings.push(warning('도구 목록', '도구가 하나도 없습니다 — 에이전트도 화면도 부를 것이 없습니다'))

  for (const t of tools) {
    const where = `도구 ${t.name}`
    const nameError = toolNameError(t.name)
    if (nameError) findings.push(problem(where, `${nameError} — Centralu가 이 도구를 빼서 아무도 부를 수 없습니다`))
    const vis = visibilityOf(t)
    if (!vis.ok) findings.push(problem(where, `${vis.error} — Centralu가 이 도구를 뺍니다`))
    else if (vis.visibility.length === 0) findings.push(warning(where, '_meta.ui.visibility가 빈 배열이라 에이전트도 화면도 부를 수 없습니다'))

    const ann = t.annotations
    const readOnly = typeof ann?.readOnlyHint === 'boolean' ? ann.readOnlyHint : null
    if (readOnly === null) {
      findings.push(
        problem(
          where,
          'annotations.readOnlyHint가 없습니다 — 읽기만 하면 `readOnlyHint: true`, 무엇이든 바꾸면 `readOnlyHint: false`를 적으세요. ' +
            '없으면 바꾸는 도구로 다뤄져 세션이 부를 때마다 묻고, Codex의 auto 프리셋은 부르지 않습니다',
        ),
      )
    } else if (readOnly && ann?.destructiveHint === true) {
      findings.push(warning(where, 'readOnlyHint: true인데 destructiveHint: true입니다 — 둘 중 하나가 틀렸습니다'))
    }
    if (!t.description?.trim()) findings.push(warning(where, 'description이 없습니다 — 에이전트는 설명을 보고 도구를 고릅니다'))

    // 고정 화면을 여는 쪽(`homeView`)과 같은 판정이다 — 점검이 통과시킨 선언을 화면이 거절하면 안 된다
    const ui = resourceUriOf(t)
    if (ui.error) findings.push(problem(where, `${ui.error} — 화면으로 뜨지 않습니다`))
    if (ui.uri) screens.add(ui.uri)
    summaries.push({ name: t.name, visibility: vis.ok ? vis.visibility : [], readOnly, screen: ui.uri })
  }

  if (manifest.home) {
    const where = `home (${manifest.home})`
    const home = tools.find((t) => t.name === manifest.home)
    if (!home) {
      findings.push(problem(where, `centralu.app.json의 home이 가리키는 도구가 도구 목록에 없습니다 — 사이드바에서 앱을 열 수 없습니다`))
    } else {
      if (resourceUriOf(home).uri === null) {
        findings.push(problem(where, 'home 도구에 화면이 없습니다 — `_meta: { ui: { resourceUri: "ui://…" } }`를 달고 그 리소스를 `centralu.uiResource`로 등록하세요'))
      }
      const vis = visibilityOf(home)
      if (vis.ok && !vis.visibility.includes('app')) {
        findings.push(problem(where, `home 도구가 화면에 열려 있지 않습니다 (visibility: ${JSON.stringify(vis.visibility)}) — 앱을 열 때 Centralu는 화면의 자리에서 home을 부릅니다`))
      }
    }
  }
  return { findings, tools: summaries, screens: [...screens] }
}

/** 화면 리소스 하나의 판정 — 읽은 결과 또는 읽다 난 오류 */
export function checkScreen(uri: string, read: ReadResourceResult | Error): { findings: CheckFinding[]; chars: number } {
  const where = `화면 ${uri}`
  if (read instanceof Error) return { findings: [problem(where, `읽지 못했습니다: ${read.message.split('\n')[0]}`)], chars: 0 }
  const content = read.contents.find((c) => c.uri === uri) ?? read.contents[0]
  if (!content) return { findings: [problem(where, '읽었지만 내용이 비어 있습니다 (contents가 없습니다)')], chars: 0 }
  const findings: CheckFinding[] = []
  if (content.mimeType !== UI_MIME) {
    findings.push(problem(where, `mimeType이 ${JSON.stringify(content.mimeType ?? null)}입니다 — 화면은 "${UI_MIME}"이어야 합니다 (centralu.uiResource가 맞춰 줍니다)`))
  }
  const text = 'text' in content && typeof content.text === 'string' ? content.text : null
  if (text === null) {
    findings.push(warning(where, 'HTML이 글이 아니라 blob으로 왔습니다 — Centralu의 템플릿은 글로 냅니다'))
    return { findings, chars: 0 }
  }
  if (!text.trim()) findings.push(problem(where, 'HTML이 비어 있습니다'))
  if (text.includes(BRIDGE_TAG)) {
    findings.push(problem(where, `<script src="${BRIDGE_TAG}">가 그대로 남았습니다 — 이 화면에는 브리지가 없어 도구를 부를 수 없습니다. centralu.uiResource로 등록하세요`))
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
  lines.push(
    ok
      ? `check ${label}: 통과${warnings.length ? ` (주의 ${warnings.length}개)` : ''}`
      : `check ${label}: 문제 ${problems.length}개${warnings.length ? `, 주의 ${warnings.length}개` : ''} — 고친 뒤 다시 check를 부르세요`,
  )
  for (const f of [...problems, ...warnings]) lines.push(`- ${f.level === 'problem' ? '문제' : '주의'} [${f.where}] ${f.message}`)
  for (const n of context.notes) lines.push(`- 참고: ${n}`)
  if (r.tools.length) {
    lines.push('도구:')
    for (const t of r.tools) {
      const kind = t.readOnly === true ? '읽기' : t.readOnly === false ? '바꿈' : 'readOnlyHint 없음'
      const who = t.visibility.join('+') || '아무도'
      lines.push(`  ${t.name} — ${kind}, ${who}${t.screen ? `, 화면 ${t.screen}` : ''}`)
    }
  }
  for (const s of r.screens) lines.push(`화면 ${s.uri}: ${s.chars}자`)
  if (context.process) lines.push(`프로세스: ${context.process}`)
  if (!ok && context.stderr) lines.push(`앱의 표준에러 (마지막 줄들):\n${context.stderr}`)
  return { ok, ...r, text: lines.join('\n') }
}
