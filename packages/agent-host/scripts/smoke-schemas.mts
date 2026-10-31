/**
 * Do the 50 result schemas **match the host's real responses?**
 *
 * The result schemas in `commands.ts` had never once run against the runtime — they were
 * documentation, not a guarantee. This checks them before validation is turned on: if even one
 * schema is wrong, turning validation on would kill a feature that used to work fine.
 *
 * Run with: pnpm smoke:schemas
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { openHost, removeTemp } from './host-client.mjs'
import { RpcMethods, type RpcMethodName } from '@cc/protocol'

const cwd = mkdtempSync(join(tmpdir(), 'cc-schema-'))
// Has to be an actual repository to genuinely exercise a source-control lookup
execSync('git init -q && git commit -q --allow-empty -m init', { cwd })
writeFileSync(join(cwd, 'a.txt'), 'hello\n')

// Some of the cases write: into the store, which is in memory, and under the data folder, which is this temporary one
const data = mkdtempSync(join(tmpdir(), 'cc-schema-data-'))
const client = await openHost({ timeoutMs: 30000, env: { CC_DATA_DIR: data } })
const { call: rpc } = client

// ── First create what checking needs ────────────────────────────────
const project = (await rpc('projects.add', { path: cwd })) as { id: string }
const session = (await rpc('agents.createSession', {
  projectId: project.id,
  cwd,
  tool: 'claude',
  permissionPreset: 'normal',
})) as { id: string }
const term = (await rpc('terminal.create', { projectId: project.id, cols: 80, rows: 24 })) as { terminalId: string }

const P = project.id
const S = session.id
const T = term.terminalId

/** What to send for each method. null means "cannot be called for this check" + a reason */
const CASES: Partial<Record<RpcMethodName, unknown>> & Record<string, unknown> = {
  'projects.list': {},
  'requests.list': {},
  'projects.add': { path: cwd },
  'projects.reorder': { orderedIds: [P] },
  'projects.setCommands': { projectId: P, commands: [{ command: 'echo for the check' }] },
  'projects.gitStatus': { projectId: P },
  'sessions.list': {},
  'sessions.reorder': { projectId: P, orderedIds: [S] },
  'messages.load': { sessionId: S, limit: 10 },
  'agents.detect': {},
  'agents.capabilities': { tool: 'claude' },
  'agents.models': { tool: 'claude' },
  'agents.usage': { tool: 'claude' },
  'agents.account': { tool: 'claude' },
  'agents.commands': { sessionId: S },
  'agents.listExternalSessions': { projectId: P, tool: 'claude', limit: 3 },
  'agents.switchTool': { sessionId: S, tool: 'claude' },
  'agents.updateSettings': { sessionId: S, model: null, effort: null, permissionPreset: 'normal' },
  'sessions.rename': { sessionId: S, name: 'for the check' },
  'sessions.markRead': { sessionId: S, seq: 0 },
  'agents.interrupt': { sessionId: S },
  'agents.clearBackgroundTasks': { sessionId: S },
  'agents.archiveSession': { sessionId: S, archived: false },
  'agents.resumeSession': { sessionId: S },
  'orchestrator.get': {},
  'orchestrator.tools': {},
  'grid.get': { tagged: true },
  'grid.set': { panels: [{ kind: 'session', sessionId: S }], sessionIds: [S] },
  'workspace.save': { layout: { focusedSessionId: S } },
  'workspace.load': {},
  'approvals.rules': {},
  'trash.list': {},
  'files.search': { projectId: P, query: 'a' },
  'fs.listDir': { projectId: P, path: '' },
  'fs.readFile': { projectId: P, path: 'a.txt' },
  'git.status': { projectId: P },
  'git.log': { projectId: P, limit: 5 },
  'git.branches': { projectId: P },
  'git.diff': { projectId: P, path: 'a.txt' },
  'git.stage': { projectId: P, paths: ['a.txt'] },
  'messages.search': { query: 'x', limit: 5 },
  'terminal.list': { projectId: P },
  'terminal.input': { terminalId: T, data: '\n' },
  'terminal.resize': { terminalId: T, cols: 80, rows: 24 },
  'terminal.restart': { terminalId: T, cols: 80, rows: 24 },
  'agents.createSession': { projectId: P, cwd, tool: 'claude', permissionPreset: 'normal' },
  // A disposable temp repository — actually committing and checking out loses nothing
  'git.commit': { projectId: P, message: 'commit for the check' },
  'git.checkout': { projectId: P, branch: 'main', dryRun: true },
  // Fails because there is no remote. **Whether that failure response matches the schema** is what is being checked
  'git.push': { projectId: P },
  'attachments.save': { sessionId: S, name: 'a.txt', mime: 'text/plain', dataBase64: 'aGk=' },
  'approvals.deleteRule': { id: 999999 },
  // Only sends it and checks the response shape (a full turn is covered by smoke.mjs)
  'agents.send': { sessionId: S, text: 'hi' },
  // Answers even for a nonexistent app — the building session is null, the error bundle is an empty list (M4 C-2, C-6)
  'apps.builder': { appId: 'no-such-app', projectId: P },
  'apps.errors': { appId: 'no-such-app', projectId: P },
  // A conversation that never opened a view — holds no view (M4 B-1)
  'apps.inlineViews': { sessionId: S },
  // Cancels a nonexistent import — passes through quietly (M4 E-3)
  'apps.importCancel': { token: 'no-such-import' },
  // A capability question and its remembered answer (M4 D-4) — nothing is being asked, and a nonexistent app has no remembered answer (an empty list). Forgetting something that does not exist is fine
  'apps.questions': {},
  'apps.permissions': { appId: 'no-such-app', projectId: P },
  'apps.forgetPermission': { appId: 'no-such-app', projectId: P, capability: 'agent:claude' },
  'apps.usage': { appId: 'no-such-app', projectId: P },
  // Reads that need nothing, or only the project or session made above
  'agents.mcpProposals': {},
  'agents.skillProposals': {},
  'agents.orchestratorSkills': {},
  'agents.sleepPolicy': {},
  'agents.versions': {},
  'agents.reportOwed': { sessionId: S },
  'agents.archiveLosses': { sessionId: S },
  'agents.worktreeStatus': { sessionId: S },
  'usage.history': { from: '2020-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z', groupBy: 'day', by: 'tool' },
  'subagents.usage': {},
  'orchestrator.peek': {},
  'git.ignoredEntries': { projectId: P },
  'projects.inspect': { path: cwd },
  'projects.origin': { projectId: P },
  'projects.deleteOutlook': { projectId: P },
  'processes.strays': {},
  'commands.state': { projectId: P },
  'apps.list': {},
  'apps.runs': { appId: 'no-such-app', projectId: P },
  'apps.reach': { sessionId: S, appId: 'no-such-app', projectId: P },
  'projectConsents.list': {},
  'updates.status': {},
  'machines.list': {},
  'machines.sshHosts': {},
  'machines.askConsents': {},
  'host.activity': {},
  'host.sessions': {},
  'host.hubAuto': {},
  'host.readSession': { sessionId: S },
  'host.recall': { query: 'the check' },
  'host.lastAnswer': { sessionId: S },
  'mail.list': {},
  'prefs.get': {},
  'themes.list': {},
  // Writes into the temporary store that the checks after them do not read
  'projects.setAgentInstructions': { projectId: P, text: '' },
  'projects.setWorktreeSetup': { projectId: P, setup: null },
  'orchestrator.configure': { tool: 'claude' },
  'git.cancel': { projectId: P },
  'fs.resolve': { projectId: P, path: 'a.txt' },
  'agents.exportHandoffRecord': { sessionId: S },
  'agents.exportHandoffNote': { sessionId: S, afterSeq: 0 },
  'themes.resolve': { id: 'no-such-theme' },
  'prefs.set': { patch: {} },
  'agents.setAutoApplyVersions': { enabled: false },
  'agents.setSleepPolicy': { afterMinutes: null },
  'projects.createPreview': { name: 'check' },
  'agents.autoCompact': { sessionId: S },
  'host.setHubAuto': { allowed: false },
  'updates.setAuto': { enabled: false },
  'updates.setAutoApply': { enabled: false },
  // Last: it restarts the project's idle sessions in the background, as agents.restartSession does
  'projects.setTrusted': { projectId: P, trusted: true },
}

/** Several methods left out for one reason */
const skipped = (why: string, methods: string[]) => Object.fromEntries(methods.map((m) => [m, why]))

/** What cannot be called, and why — leaving it out silently would read as "everything was checked" */
const SKIP: Record<string, string> = {
  ...skipped('needs a linked machine, which a headless host does not have (machines.test.ts, links.test.ts)', [
    ...['add', 'probe', 'remove', 'reconnect', 'disconnect', 'setAutoReconnect', 'setConnect', 'need', 'acceptVersions', 'install', 'update', 'cancelUpdate', 'rollback', 'uninstall', 'autostart', 'activity', 'hubAuto', 'setAsks', 'withdrawAsk'].map((m) => `machines.${m}`),
    'host.hubOffer',
  ]),
  ...skipped('installs, signs in, updates, or ends the host, an agent tool or a process for real', [
    'agents.installTool', 'agents.cancelInstallTool', 'agents.signIn', 'agents.cancelSignIn', 'agents.applyVersions', 'updates.apply', 'updates.answerApply', 'updates.reportApply', 'host.stop', 'host.handover', 'processes.stop', 'commands.stop',
  ]),
  ...skipped('destructive, or writes outside the temporary store', [
    'agents.archiveIfAtRest', 'agents.deleteAgentChild', 'agents.deleteOrchestratorSkill', 'trash.purgeRuns', 'trash.purgeSubagentSteps', 'trash.restoreSubagentSteps', 'fs.move', 'fs.importFile', 'projects.delete', 'projects.create', 'worktrees.createManager', 'worktrees.setTrunk', 'themes.save', 'themes.import',
  ]),
  ...skipped('needs something that does not exist here: a pending proposal, a running task, a failed turn, an image, a subagent run, a running command, an open app view, a shared app, a consent, a mail thread', [
    'agents.resolveMcpProposal', 'agents.resolveSkillProposal', 'agents.stopBackgroundTask', 'messages.image', 'sessions.clearError', 'messages.subagent', 'messages.subagentTrashed', 'trash.readRun', 'subagents.trash', 'commands.log', 'commands.resize', 'apps.viewFrame', 'apps.recoverView', 'apps.readResource', 'apps.invoke', 'apps.restart', 'apps.setShared', 'projectConsents.revoke', 'host.send',
    ...['thread', 'reply', 'close', 'reassign', 'unblock', 'held', 'resume', 'wake'].map((m) => `mail.${m}`),
  ]),
  'fs.watch': 'a stream of changes, not a call with an answer',
  'host.credentials': 'hands out a credential, which only a limited call asks for (links.test.ts)',
  'agents.respondApproval': 'needs a pending approval request (covered by smoke.mjs)',
  'machines.revokeCredential': 'needs a linked machine with another full credential (links.test.ts)',
  'requests.answer': 'needs a host request, which only a limited call raises while a window shows them (host-requests.test.ts)',
  'agents.answerQuestion': 'needs a pending question request (same reason as the approval one)',
  'agents.forkConversation': 'needs a locked codex conversation — cannot be created headlessly',
  'agents.restartSession': 'actually swaps out the process — would shake up the checks that follow',
  'agents.deleteSession': 'destructive — called separately at the very end',
  // The trash (#204) needs a session in it — the end of the script puts one there and walks the ways out
  'trash.read': 'needs a session in the trash — called at the end',
  'trash.restore': 'needs a session in the trash — called at the end',
  'trash.purge': 'needs a session in the trash — called at the end',
  'trash.empty': 'deletes everything in the trash for good — called at the end',
  'git.commitDetail': 'needs a commit sha — filled in from the git.log result',
  'terminal.create': 'already called and checked above',
  'terminal.close': 'called separately at the very end',
  'commands.run': 'runs a slash command — has side effects',
  'apps.sessionTools': 'Codex-bridge only — needs a live session with an external app attached (covered end-to-end by adapters/codex/apps.test.ts)',
  'apps.sessionCall': 'Codex-bridge only — same reason as apps.sessionTools',
  'apps.remove': 'destructive — moves a user-folder app away (covered by sessions/mcp-apps.test.ts)',
  'apps.openView': 'needs an external app with a home view in a trusted project (covered by app-home-view.test.ts with a real app)',
  'apps.closeView': 'needs an instance opened by apps.openView — covered by the same test',
  'apps.viewDocument': 'needs an open view instance — a hub asks it of a linked machine (covered by app-home-view.test.ts with a real app, and links/router.test.ts)',
  'apps.holdViews': 'needs a leased instance opened by apps.openView over a window connection (covered by views/view-host.test.ts and transport/server.test.ts)',
  'apps.create': 'creates an app folder and its builder session (a real agent) (covered by sessions/create-app.test.ts and app-builder.test.ts)',
  'apps.createBuilder': 'launches a builder session (a real agent) — same reason as apps.create',
  'apps.check': 'actually launches the app — needs a template app (covered by apps/external/check.test.ts)',
  'apps.viewMessage': 'needs an open inline view from an app tool with a view that the session called (covered by inline-views.test.ts with a real app)',
  'apps.inlineReopen': 'needs a collapsed inline view — covered by the same test (the cap and reopening)',
  'apps.askBuilder': "feeds a message into the app's builder session (a real agent) (covered by builder-requests.test.ts and platform.contract.test.ts)",
  'apps.sendError': "needs the app's error bundle and its builder session (a real agent) — covered by builder-requests.test.ts",
  'apps.answerQuestion': 'needs a pending capability question from a chain that started in a view (covered by sessions/app-capabilities.test.ts with a real app)',
  'apps.setSecret': 'needs an app that declares a secret — writes the secret value onto this machine (covered by app-secrets.test.ts with a real app)',
  'apps.importPrepare': "needs a folder or zip to import — writes into the data folder's staging area (covered by apps/external/imports.test.ts and platform.contract.test.ts)",
  'apps.importCommit': 'needs the token from a prepared import — brings the app into the user folder (covered by the same test)',
  'apps.review': 'needs an imported app (covered by the same test)',
  'apps.enable': 'needs an imported app and the key from its confirmation dialog (covered by the same test)',
  'apps.versions': 'needs an external app — user-folder apps use a snapshot, project apps use git (covered by app-versions.test.ts with a real repository)',
  'apps.restoreVersion': 'needs a user-folder app with a saved version — overwrites the app folder (covered by apps/external/versions.test.ts)',
}

const ok: string[] = []
const bad: { m: string; issues: string }[] = []
const failed: { m: string; why: string }[] = []

// orchestrator.tool can only be called by the orchestrator itself — get its id first
try {
  const orc = (await rpc('orchestrator.get', {})) as { id: string }
  CASES['orchestrator.tool'] = { sessionId: orc.id, name: 'list_sessions', args: {} }
} catch {
  SKIP['orchestrator.tool'] = 'could not create the orchestrator'
}

// git.commitDetail fills in a sha once one is obtained
try {
  const log = (await rpc('git.log', { projectId: P, limit: 1 })) as { sha: string }[]
  if (log[0]?.sha) {
    CASES['git.commitDetail'] = { projectId: P, sha: log[0].sha }
    delete SKIP['git.commitDetail']
  }
} catch {
  /* leave it skipped */
}

for (const m of Object.keys(RpcMethods) as RpcMethodName[]) {
  if (m in SKIP) continue
  if (!(m in CASES)) {
    failed.push({ m, why: 'no check case (a hole in this script)' })
    continue
  }
  try {
    const result = await rpc(m, CASES[m])
    const parsed = RpcMethods[m].result.safeParse(result)
    if (parsed.success) ok.push(m)
    else bad.push({ m, issues: JSON.stringify(parsed.error.issues.slice(0, 3)) })
  } catch (e) {
    failed.push({ m, why: (e as Error).message })
  }
}

// Destructive ones go at the very end
for (const [m, params] of [
  ['terminal.close', { terminalId: T }],
  ['agents.deleteSession', { sessionId: S }],
  ['trash.read', { sessionId: S }],
  ['trash.restore', { sessionId: S }],
  ['agents.deleteSession', { sessionId: S }],
  ['trash.purge', { sessionId: S }],
  ['trash.empty', {}],
] as const) {
  try {
    const parsed = RpcMethods[m as RpcMethodName].result.safeParse(await rpc(m, params))
    // agents.deleteSession runs twice (into the trash, and again after the restore) — count a method once
    if (!parsed.success) bad.push({ m, issues: JSON.stringify(parsed.error.issues.slice(0, 3)) })
    else if (!ok.includes(m)) ok.push(m)
  } catch (e) {
    failed.push({ m, why: (e as Error).message })
  }
  delete SKIP[m]
}

const total = Object.keys(RpcMethods).length
console.log(`\nCheck results (${total} total)`)
console.log(`  schema matched     ${ok.length}`)
console.log(`  schema mismatched  ${bad.length}`)
console.log(`  call failed        ${failed.length}`)
console.log(`  not checked        ${Object.keys(SKIP).length}`)

if (bad.length) {
  console.log('\n── Mismatches (this is where it dies once validation is turned on) ──')
  for (const b of bad) console.log(`  ${b.m}\n     ${b.issues}`)
}
if (failed.length) {
  console.log('\n── Call failures ──')
  for (const f of failed) console.log(`  ${f.m}: ${f.why}`)
}
console.log('\n── Not checked, and why ──')
for (const [m, why] of Object.entries(SKIP)) console.log(`  ${m}: ${why}`)

await client.stop()
removeTemp(data)
// A call failure counts as a failure too — if the schema could not even be checked and this
// exits 0, CI reads it as "everything is fine." Neither a mismatch nor a call failure is left green.
process.exit(bad.length || failed.length ? 1 : 0)
