/**
 * OpenCode retries a request its model's provider refuses and sends no ACP frame meanwhile (measured on 1.19.4 against a
 * provider that answers 429 "insufficient_quota": nine requests over about 70 s, then a JSON-RPC error). The first failure
 * of the model's own request is in its log at once, which `--print-logs --log-level ERROR` sends to stderr:
 *
 *   level=ERROR message="stream error" providerID=… modelID=… session.id=ses_… small=false agent=build … error.error="AI_APICallError: <provider's words>"
 *
 * `small=true` is the title it asks a small model for, which fails the same way and is not the turn.
 */
const STREAM_ERROR = /message="stream error".* small=false .*error\.error="(?:AI_\w+: )?(.*?)"\s*$/

/** A refusal that will not clear by retrying within the turn: a usage limit, a quota, credits, a rate limit */
const LIMIT = /usage limit|limit reached|quota|credits|billing|rate.?limit|\b429\b/i

export function openCodeRefusal(line: string): string | null {
  const words = STREAM_ERROR.exec(line)?.[1]?.trim()
  return words && LIMIT.test(words) ? words : null
}
