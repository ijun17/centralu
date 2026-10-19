import type { AppUses } from '@cc/protocol'

/** `uses` in plain words — one line per capability: the import review, the trust card and the inbox's app notice */
export function usesLines(uses: AppUses): string[] {
  const out: string[] = []
  if (uses.agent === true) out.push('Run your default agent in a new session')
  else if (Array.isArray(uses.agent) && uses.agent.length) out.push(`Run your agent in a new session: ${uses.agent.join(', ')}`)
  if (uses.apps?.length) out.push(`Call other apps: ${uses.apps.join(', ')}`)
  if (uses.host?.length) out.push(`Read Centralu data: ${uses.host.map((name) => HOST_DATA_WORDS[name] ?? name).join('; ')}`)
  // Kept running with nothing open while it says it is busy (#1236), in the app's own words
  if (uses.background) out.push(`Keep running in the background while busy: ${uses.background}`)
  return out
}

/** The host data names an app may declare (`HOST_CAPABILITIES`), in plain words; an unknown one is shown as it is */
const HOST_DATA_WORDS: Record<string, string> = {
  'sessions.list': "the names and states of its project's sessions (sessions.list)",
  'git.status': "its project's branch and changed files (git.status)",
}
