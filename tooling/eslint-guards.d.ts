import type { Linter } from 'eslint'

/** The `guard` plugin: the rules tooling/eslint-guards.js defines */
export const guards: { rules: Record<string, unknown> }
/** The configuration blocks that switch the rules on, each with the files it reads */
export const guardConfigs: (Linter.Config & { rules: Record<string, unknown> })[]
/** A file's lines that hold only a comment, and its lines that hold code or a comment, for a TypeScript or JavaScript text */
export function commentShareOf(text: string, file?: string): { comment: number; lines: number }
