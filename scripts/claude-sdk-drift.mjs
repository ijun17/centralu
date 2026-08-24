/**
 * Claude Agent SDK drift check (#46) — does the latest published SDK still carry
 * every name the adapter touches?
 *
 * The Codex protocol has this already (packages/agent-host/scripts/codex-bindings.mjs
 * against protocol-contract.json). The Claude side did not, and everything we know
 * about that SDK was found by hand: `resolvePermissionModeInCli` cost three discarded
 * probes, `listSessions` was found by grepping the `.d.ts`, the usage API announces
 * its own instability in its name. Hand-won knowledge rots silently — this script is
 * where it is written down and re-verified.
 *
 *   pnpm drift:claude
 *
 * What it does:
 *   1. Installs @anthropic-ai/claude-agent-sdk@latest into a temp dir — never the
 *      workspace. The lockfile pin is `pnpm verify`'s business; the question here is
 *      whether *tomorrow's* SDK still fits the adapter, asked before an upgrade does.
 *   2. Imports it and asserts the module exports the adapter imports.
 *   3. Scans the shipped .d.ts for every typed name the adapter reads — methods on
 *      the Query handle, option keys it sends, response fields it picks out.
 *   4. Scans the shipped runtime too, for the names the types do not admit:
 *      `resolvePermissionModeInCli` is what makes the `normal` permission preset
 *      follow the user's own settings (measured, probe-perm2.mts: omitting it makes
 *      the SDK freeze permissionMode to 'default'), yet as of 0.3.231 it appears
 *      only in sdk.mjs and nowhere in any .d.ts. If it leaves the runtime as
 *      quietly as it lives there, that preset dies with no error anywhere.
 *   5. Asserts every contract name still appears in adapters/claude source — the
 *      reverse direction, so this list cannot outlive the code it describes.
 *
 * Honest scope: these are name checks, same as the Codex side. They catch the
 * `contextWindow` → `modelContextWindow` class of drift (3ae2029: a name we read
 * left the vendor surface) and cannot catch the `total` vs `last` class (970b674:
 * both names real, wrong one chosen). Semantics are guarded where they can be —
 * the adapter's runtime plausibility checks — not here.
 *
 * The list holds only names distinctive enough that finding them in the vendor's
 * files is evidence. `cwd`, `model`, `name` would match anything and prove nothing,
 * so they are deliberately absent even though the adapter uses them.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ADAPTER = join(ROOT, 'packages/agent-host/src/adapters/claude')
const PKG = '@anthropic-ai/claude-agent-sdk'

/** Module exports the adapter imports. Checked on the real module, not the types. */
const EXPORTS = [
  'query', // index.ts — the session itself
  'createSdkMcpServer', // orchestrator-mcp.ts — in-process orchestrator tools (FR-11)
  'tool', // orchestrator-mcp.ts
  'listSessions', // history.ts — feature-detected there; this makes its loss loud instead
  'getSessionMessages', // history.ts
]

/** Names that must appear in the shipped .d.ts. Grouped by where the adapter reads them. */
const TYPED = [
  // Query handle methods (index.ts QueryHandle — the slice of Query we depend on)
  'interrupt',
  'supportedCommands',
  'getContextUsage',
  'supportedModels', // models.ts — the model list is the SDK's, never hardcoded
  'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET', // usage.ts — unstable by its own name; if renamed, the usage card folds and we want to know first
  // Options index.ts sends into query()
  'pathToClaudeCodeExecutable', // bundled host cannot use the SDK's own CLI path
  'includePartialMessages',
  'mcpServers',
  'settingSources', // [] is a security decision — orchestrator reads no files
  'systemPrompt',
  'resume',
  'canUseTool', // approvals AND AskUserQuestion both ride on this one callback
  'permissionMode',
  'bypassPermissions', // the 'auto' preset is this literal
  // listSessions options and row fields (history.ts)
  'includeProgrammatic',
  'sessionId',
  'customTitle',
  'firstPrompt',
  'lastModified',
  'gitBranch',
  // supportedModels / supportedCommands row fields (models.ts, index.ts)
  'displayName',
  'supportsEffort',
  'supportedEffortLevels',
  'argumentHint',
  // getContextUsage fields (index.ts) — the modelContextWindow lesson, Claude edition
  'totalTokens',
  'maxTokens',
  // usage response fields (usage.ts)
  'subscription_type',
  'rate_limits',
  'resets_at',
  // canUseTool result field (index.ts)
  'updatedInput',
]

/** Names that need only exist somewhere in the shipped package, types included or not. */
const RUNTIME_ONLY = [
  'resolvePermissionModeInCli', // index.ts permissionOptionsFor — see header, step 4
]

const words = (text) => text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []

function filesIn(dir, suffixes) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue // the SDK's deps are not its surface
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesIn(p, suffixes))
    else if (suffixes.some((s) => entry.name.endsWith(s))) out.push(p)
  }
  return out
}

function identifierSet(files) {
  const found = new Set()
  for (const f of files) for (const w of words(readFileSync(f, 'utf8'))) found.add(w)
  return found
}

// 5 first, cheapest: the contract must describe the adapter as it is today, or the
// rest of this run would be asserting names nobody depends on anymore.
const adapterSource = identifierSet(
  readdirSync(ADAPTER)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(ADAPTER, f)),
)
const stale = [...EXPORTS, ...TYPED, ...RUNTIME_ONLY].filter((n) => !adapterSource.has(n))
if (stale.length > 0) {
  console.error(
    `[claude-sdk] contract is stale — ${stale.length} name(s) no longer appear in adapters/claude:\n  ` +
      stale.join('\n  ') +
      '\n→ the adapter stopped depending on these; remove them from scripts/claude-sdk-drift.mjs.',
  )
  process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), 'claude-sdk-drift-'))
try {
  try {
    // --prefix keeps everything inside tmp; the repo's lockfile is never in play.
    execFileSync(
      'npm',
      ['install', '--prefix', tmp, '--no-audit', '--no-fund', '--loglevel=error', `${PKG}@latest`],
      { stdio: 'pipe' },
    )
  } catch (e) {
    console.error(`[claude-sdk] could not install ${PKG}@latest:`, e.message)
    process.exit(1)
  }

  const sdkDir = join(tmp, 'node_modules', PKG)
  const version = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')).version

  const missing = []

  // 2 — the exports, on the module itself. If the import throws, that is a finding,
  // not noise: the adapter does the same top-level import and would die identically.
  let mod
  try {
    mod = await import(pathToFileURL(createRequire(join(tmp, 'x.js')).resolve(PKG)).href)
  } catch (e) {
    console.error(`[claude-sdk] importing ${PKG}@${version} threw — the adapter would too:`, e.message)
    process.exit(1)
  }
  for (const name of EXPORTS) {
    if (typeof mod[name] !== 'function') missing.push(`export: ${name}`)
  }

  // 3 and 4 — the names, in what the package ships.
  const typed = identifierSet(filesIn(sdkDir, ['.d.ts']))
  const runtime = identifierSet(filesIn(sdkDir, ['.mjs', '.js']))
  for (const name of TYPED) {
    if (!typed.has(name)) missing.push(`typed surface: ${name}`)
  }
  for (const name of RUNTIME_ONLY) {
    if (!typed.has(name) && !runtime.has(name)) missing.push(`runtime surface: ${name}`)
  }

  if (missing.length > 0) {
    console.error(
      `[claude-sdk] the SDK moved (${version}). ${missing.length} name(s) we depend on are gone:\n  ` +
        missing.join('\n  ') +
        '\n→ adapt packages/agent-host/src/adapters/claude and update scripts/claude-sdk-drift.mjs.',
    )
    process.exit(1)
  }

  console.log(
    `[claude-sdk] contract holds (${version}) — ${EXPORTS.length} exports, ${TYPED.length} typed names, ${RUNTIME_ONLY.length} runtime-only name all present`,
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
