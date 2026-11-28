import type { Attachment } from '@cc/protocol'
import { realOs } from '../../os/real.js'
import { withAttachmentPaths } from '../contract.js'
import { IMAGE_MAX_BYTES, sniffImage } from '../images.js'

/** A message as `session/prompt` takes it, its attachments included (docs/plans/acp-adapter.md §5.8): ACP's content blocks */
export type PromptBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

const looksLikeImage = (a: Attachment): boolean => a.kind === 'image' || a.mime?.startsWith('image/') === true

/**
 * The picture an attachment is, as an image block, or null when it is not handed over as one: a file that is gone or cannot be
 * read, one larger than an image event may be (the same ceiling as an image coming out), or bytes that are no whole picture of a
 * format the window draws. The mime comes from the bytes: an agent that is handed a type its bytes are not fails the turn
 */
async function imageBlock(a: Attachment, cwd: string): Promise<PromptBlock | null> {
  const { files, paths } = realOs()
  const path = paths.path.isAbsolute(a.path) ? a.path : paths.path.join(cwd, a.path)
  try {
    if ((await files.promises.stat(path)).size > IMAGE_MAX_BYTES) return null
    const buf = await files.promises.readFile(path)
    const seen = sniffImage(buf)
    return seen?.complete ? { type: 'image', data: buf.toString('base64'), mimeType: seen.mime } : null
  } catch {
    return null
  }
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
