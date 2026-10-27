#!/usr/bin/env node
/**
 * The approval gate for Antigravity CLI (`agy`): its `PreToolUse` hook command (docs/plans/antigravity-adapter.md §5).
 *
 * `agy` runs this before every tool call, its sub-agents' included, with the call as JSON on stdin, and waits for a JSON
 * answer on stdout. The session runs with `--dangerously-skip-permissions`, so this answer is the only gate.
 *
 * Nothing here is conditional: whatever name or path this file is run under, it reads the call and prints one answer
 * (`gate-answer.mjs`, where the tests drive it). `agy` passes its environment on to its hooks (measured):
 *   CC_AGY_GATE_URL     where the session's gate listens
 *   CC_AGY_GATE_TOKEN   that gate's credential: it answers this one session's gate and nothing else
 */
import { runHook } from './gate-answer.mjs'

await runHook({ stdin: process.stdin, env: process.env, fetch: globalThis.fetch, write: (line) => process.stdout.write(line) })
