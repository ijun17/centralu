/**
 * 서브에이전트의 메시지가 **부모 스트림에 어떤 모양으로 섞여 오는가**를 재는 프로브 (#98).
 *
 * 부모 세션 대화에 서브에이전트의 도구 호출과 최종 보고가 부모의 것처럼 박혔다
 * (도그푸딩 — 보고서가 부모 답변으로 한 번, 부모 요약으로 또 한 번: "답이 두 번 보인다").
 * 고치기 전에 무엇이 오는지부터 본다:
 *
 *   - 어떤 타입(stream_event·assistant·user·system)에 parent_tool_use_id가 실려 오는가
 *   - forwardSubagentText를 켜지 않아도 서브에이전트의 **글**이 오는가
 *   - 백그라운드 에이전트의 완료는 무엇으로 오는가 (task_* system 메시지, task-notification)
 *
 * 실행: node --import tsx packages/agent-host/scripts/probe-subagent-stream.mts [--fg]
 * (소액 과금 — haiku 한 턴과 서브에이전트 하나)
 *
 * 실측 (2026-09-25, CLI 2.1.282 · SDK 0.3.263, forwardSubagentText 안 켬):
 *   - 서브에이전트의 assistant·user 메시지에 parent_tool_use_id = 띄운 Agent 호출의 id.
 *     stream_event는 전부 parent=null — 서브에이전트의 글은 델타 없이 통짜로 온다.
 *   - 백그라운드: 부모의 델타 사이사이에 서브에이전트의 assistant(thinking, tool_use)가 낀다.
 *     마지막 글("I am done.")도 parent가 달린 assistant로 **온다** (문서와 다르다).
 *   - 띄우는 순간 Agent의 tool_result가 온다: tool_use_result {status:'async_launched', agentId}.
 *     끝은 system/task_notification {tool_use_id, status, summary, usage{tool_uses, duration_ms}}.
 *     통지는 서브에이전트 안의 Bash에도 온다 (task_started owned_by_subagent, 다른 tool_use_id).
 *   - 포그라운드: 서브에이전트의 마지막 글은 스트림에 없었고, Agent의 tool_result 본문이
 *     "[Subagent hand-back] The text below is the final report…"로 시작했다.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FG = process.argv.includes('--fg')
const cwd = mkdtempSync(join(tmpdir(), 'cc-subagent-'))

const prompt = FG
  ? 'Call the Agent tool exactly once (subagent_type "general-purpose", description "probe fg", run_in_background false) ' +
    'with this prompt: "Run the Bash command `echo sub-one`, then the Bash command `echo sub-two`, then reply with one sentence saying you are done." ' +
    'After it returns, write two sentences about rivers. Do nothing else.'
  : 'First call the Agent tool exactly once (subagent_type "general-purpose", description "probe bg", run_in_background true) ' +
    'with this prompt: "Run the Bash command `sleep 3; echo sub-one`, then the Bash command `echo sub-two`, then reply with one sentence saying you are done." ' +
    'Then, without waiting for it, write a 120-word paragraph about rivers. When the agent later reports back, reply with one short sentence. Do nothing else.'

let open = true
let wake: () => void = () => {}
async function* input() {
  yield {
    type: 'user' as const,
    parent_tool_use_id: null,
    session_id: '',
    message: { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] },
  }
  while (open) await new Promise<void>((r) => (wake = r))
}

const q = query({
  prompt: input(),
  options: {
    cwd,
    // 앱과 같은 CLI를 쓴다 (어댑터가 whichTool('claude')로 사용자 설치본을 가리킨다)
    pathToClaudeCodeExecutable: execFileSync('which', ['claude']).toString().trim(),
    model: 'haiku',
    includePartialMessages: true,
    settingSources: [],
    permissionMode: 'default',
    canUseTool: async (name: string, input: Record<string, unknown>) => {
      const cmd = String(input.command ?? '')
      if (name === 'Agent' || name === 'Task' || (name === 'Bash' && /^(sleep 3; )?echo sub-/.test(cmd))) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      return { behavior: 'deny' as const, message: 'probe: not allowed' }
    },
  } as never,
})

const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(6)
let deltaRun: { parent: string; n: number; chars: number } | null = null
const flushDeltas = () => {
  if (deltaRun) console.log(`${ms()} stream_event text_delta ×${deltaRun.n} (${deltaRun.chars}자) parent=${deltaRun.parent}`)
  deltaRun = null
}
let results = 0
let notified = false
const timer = setTimeout(() => {
  console.log('!! 시간 초과')
  open = false
  wake()
  process.exit(1)
}, 240_000)

for await (const msg of q) {
  const m = msg as Record<string, unknown>
  const parent = m.parent_tool_use_id === undefined ? '(없음)' : String(m.parent_tool_use_id)
  if (m.type === 'stream_event') {
    const e = m.event as Record<string, unknown>
    const d = e.delta as Record<string, unknown> | undefined
    if (e.type === 'content_block_delta' && d?.type === 'text_delta') {
      if (deltaRun && deltaRun.parent !== parent) flushDeltas()
      deltaRun ??= { parent, n: 0, chars: 0 }
      deltaRun.n++
      deltaRun.chars += String(d.text).length
      continue
    }
    flushDeltas()
    console.log(`${ms()} stream_event ${String(e.type)}${d ? `/${String(d.type)}` : ''} parent=${parent}`)
    continue
  }
  flushDeltas()
  if (m.type === 'assistant') {
    const content = ((m.message as Record<string, unknown>).content ?? []) as Record<string, unknown>[]
    const blocks = content.map((b) =>
      b.type === 'text' ? `text(${String(b.text).length}자: ${JSON.stringify(String(b.text).slice(0, 60))})`
      : b.type === 'tool_use' ? `tool_use(${String(b.name)} ${String(b.id)} ${JSON.stringify(b.input).slice(0, 120)})`
      : String(b.type),
    )
    console.log(`${ms()} assistant parent=${parent} [${blocks.join(', ')}]`)
  } else if (m.type === 'user') {
    const c = (m.message as Record<string, unknown>).content
    const blocks = Array.isArray(c)
      ? (c as Record<string, unknown>[]).map((b) =>
          b.type === 'tool_result' ? `tool_result(${String(b.tool_use_id)} ${JSON.stringify(b.content).slice(0, 100)})` : String(b.type),
        )
      : [`string(${JSON.stringify(String(c).slice(0, 100))})`]
    const extra = ['isSynthetic', 'isReplay', 'origin', 'subagent_type', 'task_description']
      .filter((k) => m[k] !== undefined)
      .map((k) => `${k}=${JSON.stringify(m[k])}`)
    const tur = m.tool_use_result === undefined ? '' : ` tool_use_result=${JSON.stringify(m.tool_use_result).slice(0, 200)}`
    console.log(`${ms()} user parent=${parent} ${extra.join(' ')} [${blocks.join(', ')}]${tur}`)
  } else if (m.type === 'system') {
    const keys = Object.keys(m).filter((k) => !['type', 'subtype', 'uuid', 'session_id'].includes(k))
    const pick = Object.fromEntries(keys.map((k) => [k, typeof m[k] === 'string' ? String(m[k]).slice(0, 120) : m[k]]))
    if (m.subtype === 'init') console.log(`${ms()} system/init`)
    else console.log(`${ms()} system/${String(m.subtype)} ${JSON.stringify(pick).slice(0, 400)}`)
    if (m.subtype === 'task_notification') notified = true
  } else if (m.type === 'result') {
    results++
    console.log(`${ms()} result/${String(m.subtype)} parent=${parent}`)
    if (FG || notified) break
  } else {
    console.log(`${ms()} ${String(m.type)} ${JSON.stringify(m).slice(0, 200)}`)
  }
}
clearTimeout(timer)
open = false
wake()
console.log(`\nresult ${results}개 · cwd ${cwd}`)
process.exit(0)
