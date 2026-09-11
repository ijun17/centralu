import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const wrapperPath = resolve(repoRoot, 'packages/agent-host/scripts/remote-serve.mjs')
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('remote serve wrapper', () => {
  it('prints help without running the build', async () => {
    const { binDir, logPath } = fakePnpm()
    const { stdout } = await execFileAsync(process.execPath, [wrapperPath, '--help'], { cwd: repoRoot, env: testEnv(binDir, logPath) })

    expect(stdout).toContain('Usage: pnpm remote:serve')
    expect(existsSync(logPath)).toBe(false)
  })

  it('clears Vite host variables during build and forwards stripped args to the direct node host', async () => {
    const { binDir, logPath } = fakePnpm()
    let error: Error & { code?: number; stderr?: string } | undefined
    try {
      await execFileAsync(process.execPath, [wrapperPath, '--', '--definitely-bad'], {
        cwd: repoRoot,
        env: testEnv(binDir, logPath, { VITE_HOST_TOKEN: 'leaky-token', VITE_HOST_URL: 'https://leaky.example' }),
      })
    } catch (err) {
      error = err as Error & { code?: number; stderr?: string }
    }

    const build = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(build).toEqual({ event: 'pnpm', argv: ['build'], viteHostToken: '', viteHostUrl: '' })
    expect(error?.code).toBe(1)
    expect(error?.stderr).toContain("Unknown option '--definitely-bad'")
  })

  it('forwards SIGTERM to an interrupted build and does not continue to the host', async () => {
    const { binDir, logPath } = fakePnpm()
    const child = spawn(process.execPath, [wrapperPath, '--', '--definitely-bad'], {
      cwd: repoRoot,
      env: testEnv(binDir, logPath, { CENTRALU_REMOTE_SERVE_TEST_HANG: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

    await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('"event":"pnpm"'))
    child.kill('SIGTERM')
    const exit = await waitForExit(child)

    expect(exit).toEqual({ code: 143, signal: null })
    expect(readFileSync(logPath, 'utf8')).toContain('"signal":"SIGTERM"')
    expect(Buffer.concat(stderr).toString('utf8')).not.toContain('Unknown option')
  })
})

function fakePnpm(): { binDir: string; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'centralu-remote-serve-'))
  tempDirs.push(dir)
  const binDir = join(dir, 'bin')
  const logPath = join(dir, 'events.jsonl')
  const pnpmPath = join(binDir, 'pnpm')
  mkdirSync(binDir)
  writeFileSync(pnpmPath, `#!/usr/bin/env node
const { appendFileSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')
const logPath = process.env.CENTRALU_REMOTE_SERVE_TEST_LOG
mkdirSync(dirname(logPath), { recursive: true })
appendFileSync(logPath, JSON.stringify({ event: 'pnpm', argv: process.argv.slice(2), viteHostToken: process.env.VITE_HOST_TOKEN, viteHostUrl: process.env.VITE_HOST_URL }) + '\\n')
if (process.env.CENTRALU_REMOTE_SERVE_TEST_HANG === '1') {
  process.on('SIGTERM', () => { appendFileSync(logPath, JSON.stringify({ signal: 'SIGTERM' }) + '\\n'); process.exit(143) })
  process.on('SIGINT', () => { appendFileSync(logPath, JSON.stringify({ signal: 'SIGINT' }) + '\\n'); process.exit(130) })
  setInterval(() => {}, 1000)
} else {
  process.exit(0)
}
`)
  chmodSync(pnpmPath, 0o755)
  return { binDir, logPath }
}

function testEnv(binDir: string, logPath: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    CENTRALU_REMOTE_SERVE_TEST_LOG: logPath,
    CC_HOST_TOKEN: '',
    ...overrides,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for condition')
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
}
