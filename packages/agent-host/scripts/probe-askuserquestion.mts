/**
 * A probe measuring **how AskUserQuestion is actually received and answered**.
 *
 * In the orchestrator window, this tool leaked through as raw JSON with no choice UI, and the
 * tool came back as "the user did not answer." Before fixing it, first check how many paths there
 * are:
 *
 *   (a) does it come through canUseTool           → if so we can intercept and answer it
 *   (b) does it come through onUserDialog          → the official path. requires the dialog_kind name
 *   (c) does it just run to completion             → if neither, there is nowhere to hook in
 *
 * Run with: node --import tsx packages/agent-host/scripts/probe-askuserquestion.mts
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cwd = mkdtempSync(join(tmpdir(), 'cc-auq-'))
const KINDS = process.argv.includes('--kinds')

const seenTools: string[] = []
const dialogs: { kind: string; payload: unknown }[] = []
let toolResult = ''
let toolInput: unknown = null

const opts: Record<string, unknown> = {
  cwd,
  permissionMode: 'default',
  includePartialMessages: false,
  canUseTool: async (toolName: string, input: Record<string, unknown>) => {
    seenTools.push(toolName)
    if (toolName === 'AskUserQuestion') toolInput = input
    return { behavior: 'allow' as const, updatedInput: input }
  },
}

if (KINDS) {
  // The CLI only emits the kinds that are declared here (without any, it degrades to behavior with no dialog)
  opts.supportedDialogKinds = [
    'ask_user_question',
    'askUserQuestion',
    'user_question',
    'question',
    'tool_question',
    'refusal_fallback_prompt',
  ]
  opts.onUserDialog = async (req: { dialogKind: string; payload: Record<string, unknown> }) => {
    dialogs.push({ kind: req.dialogKind, payload: req.payload })
    console.log('\n>>> onUserDialog 호출됨! kind =', req.dialogKind)
    console.log('    payload =', JSON.stringify(req.payload).slice(0, 600))
    return { behavior: 'cancelled' as const }
  }
}

const q = query({
  prompt:
    'AskUserQuestion 도구를 지금 한 번 써서 나에게 물어봐: "점심 뭐 먹을까?" 선택지는 "김밥"과 "라면" 두 개. 다른 말은 하지 말고 도구만 호출해.',
  options: opts as never,
})

for await (const msg of q) {
  const m = msg as Record<string, unknown>
  if (m.type === 'assistant') {
    const content = (m.message as { content?: unknown[] })?.content ?? []
    for (const c of content) {
      const b = c as Record<string, unknown>
      if (b.type === 'tool_use') console.log(`[assistant] tool_use: ${String(b.name)}`)
    }
  }
  if (m.type === 'user') {
    const content = (m.message as { content?: unknown[] })?.content ?? []
    for (const c of content) {
      const b = c as Record<string, unknown>
      if (b.type === 'tool_result') {
        toolResult = JSON.stringify(b.content).slice(0, 700)
        console.log(`[tool_result] ${toolResult}`)
      }
    }
  }
  if (m.type === 'result') break
}

console.log('\n──────── 결과 ────────')
console.log('모드:', KINDS ? 'supportedDialogKinds 선언함' : '선언 안 함(현재 앱과 같음)')
console.log('canUseTool이 본 도구:', seenTools.join(', ') || '(없음)')
console.log('AskUserQuestion이 canUseTool로 왔나:', seenTools.includes('AskUserQuestion') ? '✅ 왔다' : '❌ 안 왔다')
console.log('onUserDialog 호출 수:', dialogs.length, dialogs.map((d) => d.kind).join(', '))
console.log('도구가 받은 인자:', JSON.stringify(toolInput)?.slice(0, 300) ?? '(못 봄)')
console.log('도구 결과:', toolResult || '(없음)')
process.exit(0)
