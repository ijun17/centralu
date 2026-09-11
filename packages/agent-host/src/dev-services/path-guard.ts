import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class UnsafePathError extends Error {
  override readonly name = 'UnsafePathError'
  readonly code = 'internal'

  constructor(message: string) {
    super(message)
  }
}

export class MissingPathError extends Error {
  override readonly name = 'MissingPathError'
  readonly code = 'internal'

  constructor(readonly rel: string) {
    super(`${rel || '.'} is no longer there`)
  }
}

export type CreatePathState = { readonly exists: boolean }

type WalkMode = 'existing' | 'create-leaf'

type WalkResult = { readonly stats: Stats; readonly exists: true } | { readonly exists: false }

export function isMissingPathError(error: unknown): error is MissingPathError {
  return error instanceof MissingPathError
}

export async function assertExistingPath(root: string, rel: string): Promise<Stats> {
  const result = await walkPath(root, rel, 'existing')
  if (!result.exists) throw new MissingPathError(rel)
  return result.stats
}

export async function assertCreatePath(root: string, rel: string): Promise<CreatePathState> {
  const result = await walkPath(root, rel, 'create-leaf')
  return { exists: result.exists }
}

export function assertExistingPathSync(root: string, rel: string): Stats {
  const result = walkPathSync(root, rel, 'existing')
  if (!result.exists) throw new MissingPathError(rel)
  return result.stats
}

async function walkPath(root: string, rel: string, mode: WalkMode): Promise<WalkResult> {
  const rootReal = await realpath(root)
  let current = rootReal
  const parts = pathParts(root, rel)
  if (parts.length === 0) return { stats: await lstat(rootReal), exists: true }

  for (const [index, part] of parts.entries()) {
    if (part === '..') {
      current = checkedParent(rootReal, current)
      continue
    }

    const candidate = join(current, part)
    assertInside(rootReal, candidate)
    let stats: Stats
    try {
      stats = await lstat(candidate)
    } catch (error) {
      if (isMissingFsPath(error) && mode === 'create-leaf' && index === parts.length - 1) return { exists: false }
      throw new MissingPathError(rel)
    }
    assertSafeComponent(stats, rel)
    if (index < parts.length - 1 && !stats.isDirectory()) throw new UnsafePathError(`${rel || '.'} is not a folder`)
    current = candidate
    if (index === parts.length - 1) return { stats, exists: true }
  }

  return { stats: await lstat(current), exists: true }
}

function walkPathSync(root: string, rel: string, mode: WalkMode): WalkResult {
  const rootReal = realpathSync(root)
  let current = rootReal
  const parts = pathParts(root, rel)
  if (parts.length === 0) return { stats: lstatSync(rootReal), exists: true }

  for (const [index, part] of parts.entries()) {
    if (part === '..') {
      current = checkedParent(rootReal, current)
      continue
    }

    const candidate = join(current, part)
    assertInside(rootReal, candidate)
    let stats: Stats
    try {
      stats = lstatSync(candidate)
    } catch (error) {
      if (isMissingFsPath(error) && mode === 'create-leaf' && index === parts.length - 1) return { exists: false }
      throw new MissingPathError(rel)
    }
    assertSafeComponent(stats, rel)
    if (index < parts.length - 1 && !stats.isDirectory()) throw new UnsafePathError(`${rel || '.'} is not a folder`)
    current = candidate
    if (index === parts.length - 1) return { stats, exists: true }
  }

  return { stats: lstatSync(current), exists: true }
}

function pathParts(root: string, rel: string): readonly string[] {
  const path = isAbsolute(rel) ? relative(resolve(root), resolve(root, rel || '.')) : rel
  const separator = process.platform === 'win32' ? /[/\\]+/ : '/'
  return path.split(separator).filter((part) => part.length > 0 && part !== '.')
}

function checkedParent(rootReal: string, current: string): string {
  const parent = dirname(current)
  assertInside(rootReal, parent)
  return parent
}

function assertInside(rootReal: string, candidate: string): void {
  const rel = relative(rootReal, candidate)
  if (rel === '') return
  if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return
  throw new UnsafePathError('Path is outside the project')
}

function assertSafeComponent(stats: Stats, rel: string): void {
  if (stats.isSymbolicLink()) throw new UnsafePathError(`${rel || '.'} contains a symbolic link`)
}

function isMissingFsPath(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
