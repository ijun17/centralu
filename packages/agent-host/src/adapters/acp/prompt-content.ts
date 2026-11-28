import type { Attachment } from '@cc/protocol'
import { realOs } from '../../os/real.js'
import { withAttachmentPaths } from '../contract.js'
import { imageEventFromDisk } from '../images.js'

/** A message as `session/prompt` takes it, its attachments included (docs/plans/acp-adapter.md §5.8): ACP's content blocks */
export type PromptBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

const looksLikeImage = (a: Attachment): boolean => a.kind === 'image' || a.mime?.startsWith('image/') === true

/**
 * The picture an attachment is, as an image block, read as an image coming out is (`imageEventFromDisk`: its size ceiling, and
 * bytes that are a whole picture), or null when it is not handed over as one. The mime comes from the bytes: an agent that is
 * handed a type its bytes are not fails the turn
 */
async function imageBlock(a: Attachment, cwd: string): Promise<PromptBlock | null> {
  const { path } = realOs().paths
  const read = await imageEventFromDisk('', path.isAbsolute(a.path) ? a.path : path.join(cwd, a.path))
  return read.type === 'message_image' && read.data ? { type: 'image', data: read.data, mimeType: read.mime } : null
}

/**
 * The text block, then each attachment the agent takes as a picture (`images`: its `initialize` advertised
 * `promptCapabilities.image`). Every other attachment is named by path in the text, as every tool is told it, so a file the
 * agent cannot be handed reaches it as it would without this and never fails the turn. A relative path is the project's,
 * read from the session's folder (`cwd`)
 */
export async function promptContent(text: string, attachments: readonly Attachment[], at: { cwd: string; images: boolean }): Promise<PromptBlock[]> {
  const blocks = await Promise.all(attachments.map(async (a) => (at.images && looksLikeImage(a) ? imageBlock(a, at.cwd) : null)))
  const named = attachments.filter((_, i) => !blocks[i])
  return [{ type: 'text', text: withAttachmentPaths(text, named) }, ...blocks.filter((b) => b !== null)]
}
