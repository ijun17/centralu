import { describe, expect, it } from 'vitest'
import { modelRejection, turnError } from './model-rejected.js'

/**
 * Which failures are "the provider refuses this session's model" (#1369): only those whose sentence has the model as
 * its subject. Picking another model is the fix for them, and retrying is not.
 */
const bad = (message: string) =>
  JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message } })

describe('modelRejection', () => {
  it.each([
    ["The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.", 'gpt-5.5'],
    ['The model `gpt-4.1-retired` does not exist or you do not have access to it.', 'gpt-4.1-retired'],
    ["The 'o3-pro' model has been deprecated.", 'o3-pro'],
  ])('finds the model in %s', (sentence, model) => {
    expect(modelRejection(bad(sentence))?.model).toBe(model)
  })

  it('reads the plain sentence and the kind on its own line, as a failed turn carries them', () => {
    expect(modelRejection("The 'opus[1m]' model is not supported\ninvalid_request_error")).toEqual({
      model: 'opus[1m]',
      reason: "The 'opus[1m]' model is not supported",
    })
  })

  it.each([
    "Tool 'image_generation' is not supported with model 'gpt-5-nano'.",
    "Unsupported parameter: 'reasoning.summary' is not supported with model 'o1-mini'.",
    "'flex' service tier is not available for model 'gpt-5.6-terra'.",
    "Unsupported value: 'xhigh' is not supported with the 'gpt-5-codex' model.",
    "This model's maximum context length is 400000 tokens. However, your messages resulted in 410000 tokens.",
  ])('leaves a refusal of something else as an ordinary failure: %s', (sentence) => {
    expect(modelRejection(bad(sentence))).toBeNull()
    expect(turnError(bad(sentence))).toMatchObject({ code: 'internal', retryable: true })
  })

  it('needs a 400 invalid_request_error: the same words from a server error are not a refusal', () => {
    expect(modelRejection(JSON.stringify({ status: 500, error: { type: 'server_error', message: "The 'gpt-5.5' model is not supported." } }))).toBeNull()
    expect(modelRejection("The 'gpt-5.5' model is not supported when using Codex.")).toBeNull()
  })
})
