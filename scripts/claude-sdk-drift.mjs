/**
 * Claude Agent SDK drift check (#46) — does the latest published SDK still carry
 * every name the adapter touches?
 *
 * The Codex protocol has this already (packages/agent-host/scripts/codex-bindings.mjs
 * against protocol-contract.json). The Claude side did not, and everything we know
 * about that SDK was found by hand: how the `normal` preset reaches the user's own
 * permission mode cost three discarded probes, `listSessions` was found by grepping the
 * `.d.ts`, the usage API announces
 * its own instability in its name. Hand-won knowledge rots silently — this script is
 * where it is written down and re-verified.
 *
 *   pnpm drift:claude            # @latest
 *   pnpm drift:claude 0.3.285    # any published version — for bisecting a red run
 *
 * What it does:
 *   1. Installs @anthropic-ai/claude-agent-sdk@latest into a temp dir — never the
 *      workspace. The lockfile pin is `pnpm verify`'s business; the question here is
 *      whether *tomorrow's* SDK still fits the adapter, asked before an upgrade does.
 *   2. Imports it and asserts the module exports the adapter imports.
 *   3. Scans the shipped .d.ts for every typed name the adapter reads — methods on
 *      the Query handle, option keys it sends, response fields it picks out.
 *   4. Scans the shipped runtime for the one behaviour the `normal` permission preset
 *      rests on and the types do not state: **an omitted `permissionMode` must reach
 *      the CLI as no `--permission-mode` flag at all**, so the CLI resolves the mode
 *      from the user's own settings. Up to 0.3.285 the SDK pinned an omitted mode to
 *      'default' unless the untyped option `resolvePermissionModeInCli` was sent
 *      (measured, packages/agent-host/scripts/probe-permission-mode.mts, a.k.a. probe-perm2);
 *      0.3.286 dropped that option and made its behaviour the default (measured live
 *      on 0.3.289, #275). So the check is no longer "is the name there" but "is the
 *      pin gone": the flag must be pushed only when a mode is set, and no
 *      `?? "default"` fallback may sit between the option and that flag. If an SDK
 *      brings the pin back, the preset silently becomes 'safe' — no error anywhere.
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
  // thinking stream (normalize.ts, #58 measured 2026-08-26): the body is encrypted, so
  // estimated_tokens is the only visible quantity — if either name leaves the surface,
  // the "Thinking · ~N tokens" row dies silently
  'thinking_delta',
  'estimated_tokens',
  // usage response fields (usage.ts)
  'subscription_type',
  'rate_limits',
  'resets_at',
  // canUseTool result field (index.ts)
  'updatedInput',
  // /goal (2026-10-03): whether the CLI offers it (the init message's command list, index.ts), the
  // Stop hook feedback the goal tracker reads (a user message marked isSynthetic, normalize.ts), the
  // id a model call announces so its text is a message of its own, and the goal event a CLI may send
  // (not sent headless today). The CLI's reply wording ("Goal set: …") is not an SDK name; it lives
  // in the CLI and no name check can see it — ClaudeGoalTracker's comment has the measured shapes.
  'slash_commands',
  'isSynthetic',
  'message_start',
  'active_goal',
  'last_reason',
]

/**
 * Step 4: does an omitted `permissionMode` still leave the mode to the CLI? Read off the
 * minified sdk.mjs, so it matches shapes, not names (identifiers change every build):
 *
 *   flag     `if(m)a.push("--permission-mode",m)` — the flag only when a mode is set.
 *   pin      `x=y??(…"default")` where both x and y are bound as `permissionMode:` — the
 *            0.3.285 shape, `zL=Pne??(e?.resolvePermissionModeInCli?void 0:"default")`.
 *   inline   `permissionMode:y??…` or `permissionMode:y="default"` — the same pin
 *            written into the object or the destructuring instead.
 *
 * A pattern check, stated honestly: it proves the shape we measured is still there and
 * the shape we measured against is absent, not that the CLI honours settings. The live
 * answer is the probe. A false red here (the SDK rewrote the code another way) costs one
 * re-measure; a false green would need the SDK to reinstate the pin in a new shape.
 * `mode ?? "default"` passed as a call argument (an SDK-internal plugin-delivery check
 * in both 0.3.285 and 0.3.289) is not a pin and is deliberately not matched.
 */
function permissionModeFindings(src) {
  const findings = []
  if (!/if\(([\w$]+)\)[\w$]+\.push\("--permission-mode",\1\)/.test(src)) {
    findings.push('runtime: `--permission-mode` is no longer pushed only when a mode is set — an omitted mode may now reach the CLI as a flag')
  }
  const bound = [...new Set([...src.matchAll(/\bpermissionMode:([\w$]+)/g)].map((m) => m[1]))]
  if (bound.length > 0) {
    const alt = bound.map((v) => v.replace(/\$/g, '\\$')).join('|')
    const pin = src.match(new RegExp(`(?<![\\w$])(?:${alt})=(?:${alt})\\?\\?[^;]{0,160}?"default"`))
    if (pin) findings.push(`runtime: an omitted permissionMode is pinned to 'default' again — ${pin[0]}`)
  } else {
    findings.push('runtime: no `permissionMode:` binding in sdk.mjs — the pin check has nothing to look at')
  }
  const inline = src.match(/\bpermissionMode:[\w$]+(?:\?\?|="default")[^,;}]{0,80}/)
  if (inline) findings.push(`runtime: an omitted permissionMode is given a fallback — ${inline[0]}`)
  return findings
}

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
const stale = [...EXPORTS, ...TYPED].filter((n) => !adapterSource.has(n))
if (stale.length > 0) {
  console.error(
    `[claude-sdk] contract is stale — ${stale.length} name(s) no longer appear in adapters/claude:\n  ` +
      stale.join('\n  ') +
      '\n→ the adapter stopped depending on these; remove them from scripts/claude-sdk-drift.mjs.',
  )
  process.exit(1)
}

// One optional argument: the version to check instead of @latest.
const spec = process.argv[2] ?? 'latest'

const tmp = mkdtempSync(join(tmpdir(), 'claude-sdk-drift-'))
try {
  try {
    // --prefix keeps everything inside tmp; the repo's lockfile is never in play.
    execFileSync(
      'npm',
      ['install', '--prefix', tmp, '--no-audit', '--no-fund', '--loglevel=error', `${PKG}@${spec}`],
      { stdio: 'pipe' },
    )
  } catch (e) {
    console.error(`[claude-sdk] could not install ${PKG}@${spec}:`, e.message)
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

  // 3 — the names, in what the package ships.
  const typed = identifierSet(filesIn(sdkDir, ['.d.ts']))
  for (const name of TYPED) {
    if (!typed.has(name)) missing.push(`typed surface: ${name}`)
  }

  // 4 — the permission-mode handoff, in the runtime query() actually runs.
  missing.push(...permissionModeFindings(readFileSync(join(sdkDir, 'sdk.mjs'), 'utf8')))

  if (missing.length > 0) {
    console.error(
      `[claude-sdk] the SDK moved (${version}). ${missing.length} thing(s) we depend on are gone:\n  ` +
        missing.join('\n  ') +
        '\n→ adapt packages/agent-host/src/adapters/claude and update scripts/claude-sdk-drift.mjs.',
    )
    process.exit(1)
  }

  console.log(
    `[claude-sdk] contract holds (${version}) — ${EXPORTS.length} exports, ${TYPED.length} typed names present; an omitted permissionMode still reaches the CLI as no flag`,
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
