/** What each guard rule lets through, by rule and file, each with its reason; it only shrinks. */
export const EXCEPTIONS: Readonly<Record<string, Readonly<Record<string, { reason: string | Readonly<Record<string, string>>; count?: number; counts?: Readonly<Record<string, number>> }>>>>
export const ARCHIVE_ALLOWED: readonly { own?: boolean; file: string; text: string; why: string }[]
