/** What each guard rule lets through, by rule and file, each with its reason; it only shrinks. */
export const EXCEPTIONS: Readonly<Record<string, Readonly<Record<string, { reason: string | Readonly<Record<string, string>>; count?: number; counts?: Readonly<Record<string, number>> }>>>>
export const ARCHIVE_ALLOWED: readonly { own?: boolean; file: string; text: string; why: string }[]
/** The files `guard/comments` holds above its 35% share of comment lines, each at its share now */
export const COMMENT_SHARE_HELD: { readonly files: Readonly<Record<string, number>> }
