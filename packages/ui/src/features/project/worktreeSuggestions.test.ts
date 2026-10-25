import { describe, expect, it } from 'vitest'
import { envFilesOf, installCommandFor } from './worktreeSuggestions.js'

describe('what a first worktree is offered (#1512)', () => {
  it('names the install command the lockfile points at, and nothing when there is none', () => {
    expect(installCommandFor(['package.json', 'pnpm-lock.yaml'])).toBe('pnpm install')
    expect(installCommandFor(['yarn.lock'])).toBe('yarn install')
    expect(installCommandFor(['bun.lockb'])).toBe('bun install')
    expect(installCommandFor(['package-lock.json'])).toBe('npm ci')
    expect(installCommandFor(['package.json', 'README.md'])).toBeNull()
  })

  it('takes the environment files out of the ignored entries, and only those', () => {
    expect(envFilesOf(['.env', '.env.local', 'node_modules', '.environment', 'env.txt'])).toEqual(['.env', '.env.local'])
  })
})
