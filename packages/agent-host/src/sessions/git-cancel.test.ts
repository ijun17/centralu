import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentAdapter } from '../adapters/contract.js'
import type { ToolName } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { settle } from '../dev-services/process-tree.test-helpers.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { SLOW } from '../../../../tooling/test-timing.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

/*
 * #1007, through the doors the git panel uses: `git.cancel` ends the commit still running for that project, and the
 * commit answers that it was cancelled. The ending itself is covered in dev-services/git-write-cancel.test.ts.
 */
describe('git.cancel (#1007)', () => {
  let root: string
  let store: Store
  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  it('ends the commit running for the project, which answers cancelled', { timeout: 30_000 * SLOW }, async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-git-cancel-rpc-')))
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@test')
    git(root, 'config', 'user.name', 'test')
    git(root, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    git(root, 'add', 'a.txt')
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho > .git/hook-started\nsleep 30\n')
    chmodSync(join(root, '.git', 'hooks', 'pre-commit'), 0o755)

    store = new Store()
    const adapters = new Map<ToolName, AgentAdapter>()
    const rpc = createRpcHandler(new SessionManager(store, adapters, () => {}), adapters)
    const { id: projectId } = (await rpc('projects.add', { path: root })) as { id: string }

    expect(await rpc('git.cancel', { projectId })).toEqual({ cancelled: false })
    const commit = rpc('git.commit', { projectId, message: 'one' })
    try {
      expect(await settle(() => existsSync(join(root, '.git', 'hook-started')), Boolean, 10_000 * SLOW)).toBe(true)
      expect(await rpc('git.cancel', { projectId })).toEqual({ cancelled: true })
      expect(await commit).toEqual({ ok: false, message: 'Cancelled', cancelled: true })
      expect(() => git(root, 'rev-parse', '--verify', 'HEAD')).toThrow()
    } finally {
      await rpc('git.cancel', { projectId })
      await commit.catch(() => {})
    }
  })
})
