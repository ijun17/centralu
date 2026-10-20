import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { isObj } from '../../json-value.js'

/** The loose shape the adapter reads SDK messages in, and the string reader it uses on them (one meaning, json-value.ts, #850) */
export type Json = Record<string, unknown>
export { str } from '../../json-value.js'

/**
 * `active_goal`, which the CLI sends (#304) and the SDK's `SDKMessage` does not list. Its `value` is read field by
 * field (cli-messages.ts `activeGoalEvents`).
 */
export type ClaudeActiveGoal = { type: 'active_goal'; value?: unknown }

/** One message of the stream as the SDK types it (#1339) */
export type ClaudeMessage = SDKMessage | ClaudeActiveGoal

/** The fields of `T` by the SDK's names, each read as `unknown`: what a reader may ask for, not what it may assume */
export type Loose<T> = { readonly [K in keyof T]?: unknown }

type LooseBlock<B> = B extends { type: infer K } ? { readonly type: K } & Loose<Omit<B, 'type'>> : never

type SdkUsage = SDKAssistantMessage['message']['usage']
type SdkBlock = SDKAssistantMessage['message']['content'][number] | Exclude<SDKUserMessage['message']['content'], string>[number]

/**
 * A block of a message's content as the adapter reads it (#1339): one of the SDK's block types by its `type`, with that
 * type's fields as the SDK names them, each `unknown`. The SDK's own blocks are these, so a field the SDK renames or a
 * content that may be a string fails the build; and since every value is still checked as it is read, a block from a
 * transcript another build wrote (history.ts) is one too once its `type` is known.
 */
export type ContentBlock = LooseBlock<SdkBlock>

/** A model message's body as it is read: its blocks, its request's id and its usage */
export type AssistantBody = { readonly content: readonly ContentBlock[]; readonly id?: unknown; readonly usage?: Loose<SdkUsage> | null }

/** A user message's body as it is read: words, or blocks (the SDK's `MessageParam`) */
export type UserBody = { readonly content: string | readonly ContentBlock[] }

/** A user message as it is read: its body, and the record of the one tool result it may carry */
export type UserRead = { readonly message: UserBody; readonly tool_use_result?: unknown }

/** The usage of one model request, as it is read */
export type UsageRead = Loose<SdkUsage>

/**
 * The blocks of a message's content, always a list. The CLI writes a plain string there when a message is only words,
 * as the SDK's type says — the summary it feeds back after `/compact` is one — and a reader that took the field for a
 * list threw inside the stream loop, which the adapter reported as the whole process crashed. A string reads as one
 * text block (as the imported history does, history.ts `readableMessage`); anything else that is not a list reads as
 * none, and an element that is not an object is left out: the SDK's types say what the CLI sends, and the readers
 * stay as careful as they were for a CLI that strays.
 */
export function messageBlocks(message: { readonly content?: string | readonly ContentBlock[] } | null | undefined): ContentBlock[] {
  return blocksOf(message?.content)
}

/** A content field as blocks, whatever it holds (see `messageBlocks`): for a transcript row as much as a live message */
export function blocksOf(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content.filter(isContentBlock) : []
}

/** The block types the adapter's readers act on; a block of another type reads as nothing anywhere */
const READ_TYPES = ['text', 'thinking', 'tool_use', 'tool_result'] as const satisfies readonly ContentBlock['type'][]

/**
 * A value is a block the readers act on: an object whose `type` is one of `READ_TYPES`. Its other fields stay `unknown`
 * and are checked as they are read, so this is all a block needs to be one.
 */
export function isContentBlock(v: unknown): v is ContentBlock {
  return isObj(v) && READ_TYPES.some((t) => t === v.type)
}

/** The blocks of an SDK message's `message.content` (see `messageBlocks`), for the readers not on the SDK's types yet */
export function contentBlocks(m: Json): Json[] {
  const message = m.message
  const content = isObj(message) ? message.content : undefined
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content.filter(isObj) : []
}
