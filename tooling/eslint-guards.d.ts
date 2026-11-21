import type { Linter } from 'eslint'

/** The `guard` plugin: the rules tooling/eslint-guards.js defines */
export const guards: { rules: Record<string, unknown> }
/** The configuration blocks that switch the rules on, each with the files it reads */
export const guardConfigs: (Linter.Config & { rules: Record<string, unknown> })[]
/** The host's source folders guard/comments reads, and those it does not read yet (the unit test requires each folder on disk in one of them) */
export const COMMENTS_SWEPT_HOST_FOLDERS: string[]
export const COMMENTS_UNSWEPT_HOST_FOLDERS: string[]
/** A file's lines that hold only a comment, and its lines that hold code or a comment, for a TypeScript or JavaScript text */
export function commentShareOf(text: string, file?: string): { comment: number; lines: number }
