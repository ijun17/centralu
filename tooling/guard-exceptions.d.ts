/** What each guard rule lets through, by rule and file, each with its reason; it only shrinks. */
export const EXCEPTIONS: Readonly<Record<string, Readonly<Record<string, { reason: string; count?: number; keys?: readonly string[] }>>>>
