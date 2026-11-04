/**
 * OpenCode retries a request its model's provider refuses and sends no ACP frame meanwhile (measured on 1.19.4 against a
 * provider that answers 429 "insufficient_quota": nine requests over about 70 s, then a JSON-RPC error). The first failure
 * of the model's own request is in its log at once, which `--print-logs --log-level ERROR` sends to stderr:
 *
 *   level=ERROR message="stream error" providerID=… modelID=… session.id=ses_… small=false agent=build … error.error="AI_APICallError: <provider's words>"
 *
 * `small=true` is the title it asks a small model for, which fails the same way and is not the turn.
 */
const STREAM_ERROR = /message="stream error".* session\.id=(\S+) small=false .*error\.error="(?:AI_\w+: )?(.*?)"\s*$/

/**
 * A refusal that will not clear by retrying: a usage limit, a quota, credits. A rate limit is left out: it passes in seconds
 * or a minute, which OpenCode waits for (the provider's `retry-after`), and ending the turn would turn a slow answer into a
 * failure
 */
const NO_RETRY = /usage limit|quota|credits|billing/i

/** Words that say the limit lifts soon (Gemini words a per-minute limit as a quota: "Please retry in 41s"): the tool's retry answers */
const LIFTS = /retry in|retry after|try again in|per.?minute|requests_per|\bRPM\b|\bTPM\b/i

/** The provider's words for a refusal of `conversation`'s own request (not a sub-agent's, nor the title's), or null */
export function openCodeRefusal(line: string, conversation: string): string | null {
  const found = STREAM_ERROR.exec(line)
  if (found?.[1] !== conversation || !found[2] || !NO_RETRY.test(found[2]) || LIFTS.test(found[2])) return null
  // The log quotes a value that has spaces as JSON does
  try {
    return String(JSON.parse(`"${found[2]}"`)).trim()
  } catch {
    return found[2].trim()
  }
}
