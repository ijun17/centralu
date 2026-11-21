import type { Linter } from 'eslint'

/** The `guard` plugin: the rules tooling/eslint-guards.js defines */
export const guards: { rules: Record<string, unknown> }
/** The configuration blocks that switch the rules on, each with the files it reads */
export const guardConfigs: (Linter.Config & { rules: Record<string, unknown> })[]
/** A path no swept glob of guard/comments reaches yet, for the unit test that pins the guard reads nothing outside the swept folders */
export const COMMENTS_UNSWEPT_EXAMPLE: string
/** A file's lines that hold only a comment, and its lines that hold code or a comment, for a TypeScript or JavaScript text */
export function commentShareOf(text: string, file?: string): { comment: number; lines: number }
