import type { ProtocolError } from '@cc/protocol'
import { asObj, str } from '../../json-value.js'

/**
 * A provider that refuses the session's model (#1369). A thread kept the model it was started with, and when the
 * provider retired it for the account, every turn failed the same way, as a generic retryable error:
 *
 *   {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.5' model is not
 *   supported when using Codex with a ChatGPT account."}}
 *
 * (a real turn, codex-cli 0.160.0 on 2026-10-20; an earlier 0.153.4 run had the same 400 for an unsupported model).
 * Retrying cannot help, and the person can: this is the one failure whose fix is to pick another model.
 */

/** The marker `ProtocolError.data` carries (`data` is free-form, so an older screen shows the error as any other) */
export const MODEL_REJECTED = 'model_rejected'

/** The model a provider's answer refuses, with the provider's own sentence; null when the failure is some other one */
export function modelRejection(message: string, errorInfo?: unknown): { model: string; reason: string } | null {
  /*
   * Codex's own classification (`TurnError.codexErrorInfo`, a bare string such as "badRequest" or an object keyed by the
   * kind) when it gives one: another kind (a usage limit, a context window, a dropped stream) is never a refused model,
   * whatever the sentence says, and "badRequest" is the 400 the provider's body would otherwise have to prove.
   */
  const kind = typeof errorInfo === 'string' ? errorInfo : errorInfo !== null && typeof errorInfo === 'object' ? Object.keys(errorInfo)[0] : undefined
  // "other" is the catch-all: it says nothing, so the sentence decides as it does with no kind
  if (kind !== undefined && kind !== 'badRequest' && kind !== 'other') return null
  const body = jsonBody(message)
  const error = asObj(body.error)
  // Codex may name the kind of error on a line of its own after the sentence (turn.error.additionalDetails)
  const reason = (str(error.message) || message)
    .split('\n')
    .filter((line) => line.trim() !== 'invalid_request_error')
    .join('\n')
  // A 400 (Codex's "badRequest", else the provider's invalid_request_error), naming a model it will not serve. Other 400s are not this one
  if (kind !== 'badRequest') {
    if (body.status !== undefined && body.status !== 400) return null
    if (str(error.type) !== 'invalid_request_error' && !/invalid_request_error/.test(message)) return null
  }
  const model = refusedModelIn(reason)
  if (!model) return null
  return { model, reason }
}

const NAME = String.raw`['"\`]([^'"\`]+)['"\`]`
const NOT_SERVED = String.raw`(?:(?:is|was|are) (?:not supported|unsupported|not available|no longer (?:supported|available)|retired|deprecated)|does not exist|has been (?:retired|deprecated)|not found)`
const MODEL_FIRST = new RegExp(String.raw`\bthe ${NAME} model ${NOT_SERVED}`, 'i')
const NAME_AFTER_MODEL = new RegExp(String.raw`\bthe model ${NAME} ${NOT_SERVED}`, 'i')

/**
 * The model a sentence says the provider will not serve, with the model as its subject: "The 'gpt-5.5' model is not
 * supported …", "The model `x` does not exist …". A sentence that only has a model in it is another refusal and
 * stays an ordinary failure: "Tool 'image_generation' is not supported with model 'gpt-5-nano'", "'flex' service tier is
 * not available for model 'gpt-5.6-terra'", "Unsupported parameter: 'reasoning.summary' is not supported with model
 * 'o1-mini'", reasoning effort "… not supported with the 'gpt-5-codex' model". Picking another model may not help those.
 */
function refusedModelIn(sentence: string): string | null {
  return (MODEL_FIRST.exec(sentence) ?? NAME_AFTER_MODEL.exec(sentence))?.[1] ?? null
}

/** An error event for a turn that failed with `message`: its own kind when the model was refused, else Codex's sentence as it is */
export function turnError(message: string, errorInfo?: unknown): ProtocolError {
  const rejected = modelRejection(message, errorInfo)
  if (!rejected) return { code: 'internal', message, retryable: true }
  return {
    code: 'internal',
    message: `Codex refused the model ${rejected.model}: ${rejected.reason}`,
    retryable: false,
    data: { reason: MODEL_REJECTED, model: rejected.model },
  }
}

function jsonBody(message: string): Record<string, unknown> {
  const start = message.indexOf('{')
  if (start < 0) return {}
  try {
    return asObj(JSON.parse(message.slice(start)))
  } catch {
    return {}
  }
}
