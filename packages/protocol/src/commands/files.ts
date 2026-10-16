import { z } from 'zod'

/**
 * The cap on a single attachment (#94) — counted in base64 characters. A 32MiB original comes
 * out to this length.
 *
 * There used to be no cap here at all. The overall total is capped at 500MB by
 * `sweepAttachments`, but that cleanup never looks at files arriving through this path, so this
 * is the only thing stopping a single call from filling the disk. On top of that, the string is
 * held whole in the host's memory before it ever becomes a file — a rejection only means
 * anything if it happens before the write. 32MiB was chosen as comfortably larger than a pasted
 * screenshot (a few MB), while still not large enough to bring down the host in one call.
 */
export const ATTACHMENT_MAX_BASE64 = Math.ceil((32 * 1048576) / 3) * 4

/**
 * Why `messages.image` did not return a picture. The reply shows this in place of the image, with the path the
 * agent wrote, so a word the person can act on rather than the browser's broken-image mark.
 *
 *   not_mentioned  the path is not in any of this session's own replies: the call reads only what the agent wrote
 *   not_found      nothing is there (or the path does not name a file on that machine)
 *   not_an_image   the bytes are not PNG, JPEG, GIF or WebP, whatever the name says (a folder, a text file, an SVG)
 *   too_large      past `IMAGE_PREVIEW_MAX_BYTES`
 *   unreadable     there, but the host may not read it (permissions)
 *
 * A newer host may add a reason; an older window reads it through `parseTolerant` and shows the message as it came.
 */
export const MessageImageRefusal = z.enum(['not_mentioned', 'not_found', 'not_an_image', 'too_large', 'unreadable'])
export type MessageImageRefusal = z.infer<typeof MessageImageRefusal>

/**
 * The largest image the host reads for the window to show: the file viewer's preview (`fs.readFile`) and a local image
 * a reply names (`messages.image`). 10 MB leaves room for the base64 and WebSocket copies of it.
 */
export const IMAGE_PREVIEW_MAX_BYTES = 10_000_000

/** One row of a project folder, as `fs.listDir` answers it; `path` is project-relative and POSIX-separated (paths.ts) */
export const FsEntry = z.object({ name: z.string(), path: z.string(), isDir: z.boolean(), ignored: z.boolean() })
export type FsEntry = z.infer<typeof FsEntry>

/** A file as the read-only viewer reads it (`fs.readFile`) */
export const FsFile = z.object({
  text: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
  bytes: z.number(),
  /** Raster image bytes for the read-only viewer. Never present for arbitrary binary files. */
  image: z.object({ mime: z.string(), data: z.string() }).optional(),
  /** Why an otherwise recognized image cannot be previewed (for example, its size). */
  previewError: z.string().optional(),
})
export type FsFile = z.infer<typeof FsFile>

/**
 * A local image an agent's reply names, as `messages.image` answers it.
 *
 * `file` is the absolute path the host resolved and opened, on the host's own machine, present when there is a file
 * there to show in a file manager. It is what "Show in Finder" hands to the shell; the window never builds one. The
 * hub drops it from a linked machine's answer, since that path is not on this computer.
 */
export const MessageImage = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), mime: z.string(), data: z.string(), file: z.string().optional() }),
  z.object({ ok: z.literal(false), reason: MessageImageRefusal, message: z.string(), file: z.string().optional() }),
])
export type MessageImage = z.infer<typeof MessageImage>

/** What `fs.resolve` resolves a path for (#838) */
export const FsResolvePurpose = z.enum(['trash', 'reveal', 'open'])
export type FsResolvePurpose = z.infer<typeof FsResolvePurpose>
