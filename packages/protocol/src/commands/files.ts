import { z } from 'zod'

/**
 * One attachment's cap in base64 characters (a 32 MiB original): well above a pasted screenshot, below what downs the
 * host. The only stop for one call filling the disk (`sweepAttachments`' 500 MB never sees this path), and it must
 * refuse before the write, since the host holds the whole string in memory first.
 */
export const ATTACHMENT_MAX_BASE64 = Math.ceil((32 * 1048576) / 3) * 4

/**
 * Shown with the path in place of a broken image. `not_mentioned`: in none of this session's replies, the only paths
 * the call reads; `not_an_image`: not PNG, JPEG, GIF or WebP bytes. A newer reason reaches an older window via
 * `parseTolerant`, its message as it came.
 */
export const MessageImageRefusal = z.enum([
  'not_mentioned',
  'not_found',
  'not_an_image',
  'too_large',
  'unreadable',
])
export type MessageImageRefusal = z.infer<typeof MessageImageRefusal>

/**
 * The largest image the host reads for the window (`fs.readFile` preview, `messages.image`); 10 MiB, written "10 MB",
 * leaves room for its base64 and WebSocket copies.
 */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024

/** One row of a project folder, as `fs.listDir` answers it; `path` is project-relative and POSIX-separated (paths.ts) */
export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  isDir: z.boolean(),
  ignored: z.boolean(),
})
export type FsEntry = z.infer<typeof FsEntry>

/** A file as the read-only viewer reads it (`fs.readFile`) */
export const FsFile = z.object({
  text: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
  bytes: z.number(),
  /** Raster image bytes only, never an arbitrary binary file */
  image: z.object({ mime: z.string(), data: z.string() }).optional(),
  /** Why a recognized image cannot be previewed (its size, say) */
  previewError: z.string().optional(),
})
export type FsFile = z.infer<typeof FsFile>

/** `file`: the absolute path the host opened, for "Show in Finder"; the hub drops it from a linked machine's answer */
export const MessageImage = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), mime: z.string(), data: z.string(), file: z.string().optional() }),
  z.object({
    ok: z.literal(false),
    reason: MessageImageRefusal,
    message: z.string(),
    file: z.string().optional(),
  }),
])
export type MessageImage = z.infer<typeof MessageImage>

/** What `fs.resolve` resolves a path for */
export const FsResolvePurpose = z.enum(['trash', 'reveal', 'open', 'project'])
export type FsResolvePurpose = z.infer<typeof FsResolvePurpose>
