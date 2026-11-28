/**
 * Which of the signed-in Codex's models run the multi-agent v2 runtime (#2553): `model/list`'s `multiAgentVersion` for each, with no turn (no
 * model call is spent). The v2 recording is made with one of them:
 *
 *   pnpm exec tsx packages/agent-host/scripts/probe-codex-multiagent-models.mts
 *   pnpm exec tsx scripts/frames-record.mts codex subagents-v2   (its scenario asks for gpt-6-luna, which declares v2; change `model` there if the account lacks it)
 */
import { openProbe } from './codex-probe-kit.mjs'

const { client } = await openProbe('cc-codex-models-')
try {
  const answer = await client.request<{ data?: { id?: string; model?: string; multiAgentVersion?: string | null; hidden?: boolean }[] }>('model/list', { includeHidden: true, limit: 100 })
  for (const m of answer.data ?? []) console.log(`${m.id ?? m.model}  multiAgentVersion=${String(m.multiAgentVersion ?? null)}${m.hidden ? '  (hidden)' : ''}`)
} finally {
  await client.dispose()
}
