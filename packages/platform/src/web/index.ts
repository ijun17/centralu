import { defaultCapabilities } from '../capabilities.js'
import type {
  Attachment,
  ApprovalDecision,
  ApprovalScope,
  CreateSessionParams,
  GridPanel,
  NormalizedEvent,
  SavedCommand,
  ToolName,
  QuestionAnswer,
  UpdateSettingsParams,
  GitSource,
  UsageHistoryBy,
} from '@cc/protocol/client'
import type {
  AgentPort,
  AlertKind,
  AppToolResult,
  ConnectionState,
  MachineRef,
  Platform,
  PlatformCapabilities,
  ProjectPort,
  SystemPort,
  Unsubscribe,
} from '../ports/index.js'
import { SUBAGENT_STEPS_PAGE } from '@cc/protocol/client'
import { isAppToolResult } from '../app-tool-result.js'
import { RpcClient } from './rpc-client.js'

/** The browser (dev) implementation, which the Tauri one reuses as is (docs/platform-abstraction.md §5) */
export type WebPlatformOptions = {
  /** A new port and token when the host restarts (from Tauri) */
  onEndpointChange?: (cb: (info: { port: number; token: string }) => void) => Unsubscribe
  hostUrl?: string
  token: string
  WebSocketImpl?: typeof WebSocket
  /** A dev browser tab's key, sent in each hello (`RpcClientOptions.devTabKey`) */
  devTabKey?: () => string | null
  /**
   * The two things Node cannot do: a real trash is `NSFileManager trashItem` or the freedesktop spec, not an unlink
   * into a temp folder. Absent in a browser, where the port answers `supported: false`.
   */
  nativeFiles?: {
    trash(absPath: string): Promise<void>
    reveal(absPath: string): Promise<void>
  }
  /** The desktop shell's answers, over the defaults a browser keeps */
  capabilities?: Partial<PlatformCapabilities>
  /** Gives the browser dev shell access to the underlying RpcClient (used by `apps/web` for dev tab trust) */
  onRpcClient?: (rpc: RpcClient) => void
}

/** Absent for this computer, never null: the host's schema takes a machine id or nothing */
const on = (machine?: MachineRef) => (machine ? { machine } : {})

const done = (p: Promise<unknown>): Promise<void> => p.then(() => {})

class WebAgentPort implements AgentPort {
  constructor(private rpc: RpcClient) {}
  createSession(params: CreateSessionParams) {
    return this.rpc.call('agents.createSession', params)
  }
  send(sessionId: string, text: string, attachments?: Attachment[]) {
    return done(this.rpc.call('agents.send', { sessionId, text, attachments }))
  }
  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string) {
    return this.rpc.call('attachments.save', { sessionId, name, mime, dataBase64 })
  }
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    matcher?: string,
  ) {
    return done(this.rpc.call('agents.respondApproval', { sessionId, requestId, decision, scope, matcher }))
  }
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]) {
    return done(this.rpc.call('agents.answerQuestion', { sessionId, requestId, answers }))
  }
  reorderSessions(projectId: string, orderedIds: string[]) {
    return this.rpc.call('sessions.reorder', { projectId, orderedIds })
  }

  assistant() {
    return this.rpc.call('assistant.get', {})
  }
  assistantPeek() {
    return this.rpc.call('assistant.peek', {})
  }
  configureAssistant(tool: ToolName) {
    return done(this.rpc.call('assistant.configure', { tool }))
  }
  switchTool(sessionId: string, tool: ToolName) {
    return this.rpc.call('agents.switchTool', { sessionId, tool })
  }
  // `tagged` for a host up to 0.1.0-beta.45, which answers bare session ids without it
  grid() {
    return this.rpc.call('grid.get', { tagged: true })
  }

  setGridView(panels: GridPanel[]) {
    return this.rpc.call('grid.set', { panels })
  }

  models(tool: ToolName, machine?: MachineRef) {
    return this.rpc.call('agents.models', { tool, ...on(machine) })
  }

  interrupt(sessionId: string) {
    return done(this.rpc.call('agents.interrupt', { sessionId }))
  }
  stopBackgroundTask(sessionId: string, taskId: string) {
    return done(this.rpc.call('agents.stopBackgroundTask', { sessionId, taskId }))
  }
  clearBackgroundTasks(sessionId: string) {
    return done(this.rpc.call('agents.clearBackgroundTasks', { sessionId }))
  }
  restartSession(sessionId: string) {
    return this.rpc.call('agents.restartSession', {
      sessionId,
    })
  }
  // The protocol's own type: a copy here can lack a field unseen, as TS skips the excess check on a variable
  updateSettings(sessionId: string, settings: Omit<UpdateSettingsParams, 'sessionId'>) {
    return this.rpc.call('agents.updateSettings', { sessionId, ...settings })
  }
  async autoCompact(sessionId: string) {
    return this.rpc.call('agents.autoCompact', { sessionId })
  }
  async worktreeStatus(sessionId: string) {
    return this.rpc.call('agents.worktreeStatus', { sessionId })
  }
  async exportHandoffRecord(sessionId: string, toTool?: ToolName) {
    return this.rpc.call('agents.exportHandoffRecord', { sessionId, toTool })
  }
  async exportHandoffNote(sessionId: string, afterSeq: number) {
    return this.rpc.call('agents.exportHandoffNote', { sessionId, afterSeq })
  }
  async mcpProposals() {
    return this.rpc.call('agents.mcpProposals', {})
  }
  resolveMcpProposal(name: string, approve: boolean) {
    return done(this.rpc.call('agents.resolveMcpProposal', { name, approve }))
  }
  async skillProposals() {
    return this.rpc.call('agents.skillProposals', {})
  }
  resolveSkillProposal(name: string, approve: boolean) {
    return done(this.rpc.call('agents.resolveSkillProposal', { name, approve }))
  }
  async assistantSkills() {
    return this.rpc.call('agents.assistantSkills', {})
  }
  deleteAssistantSkill(name: string) {
    return done(this.rpc.call('agents.deleteAssistantSkill', { name }))
  }

  deleteSession(sessionId: string, deleteWorktree = false, deleteExternal = false) {
    return done(this.rpc.call('agents.deleteSession', { sessionId, deleteWorktree, deleteExternal }))
  }
  archiveIfAtRest(sessionId: string, deleteExternal = false) {
    return this.rpc.call('agents.archiveIfAtRest', { sessionId, deleteExternal })
  }
  async archiveLosses(sessionId: string) {
    return (await this.rpc.call('agents.archiveLosses', { sessionId })).asks
  }
  listExternalSessions(projectId: string, tool: ToolName, limit = 30) {
    return this.rpc.call(
      'agents.listExternalSessions',
      { projectId, tool, limit },
    )
  }
  resumeSession(sessionId: string) {
    return this.rpc.call('agents.resumeSession', {
      sessionId,
    })
  }
  forkConversation(sessionId: string) {
    return this.rpc.call('agents.forkConversation', { sessionId })
  }
  rename(sessionId: string, name: string) {
    return done(this.rpc.call('sessions.rename', { sessionId, name }))
  }
  markRead(sessionId: string, seq: number) {
    return done(this.rpc.call('sessions.markRead', { sessionId, seq }))
  }
  clearError(sessionId: string, seq: number) {
    return this.rpc.call('sessions.clearError', { sessionId, seq })
  }
  stopContinue(sessionId: string) {
    return this.rpc.call('sessions.stopContinue', { sessionId })
  }
  listSessions() {
    return this.rpc.call('sessions.list', {})
  }
  loadMessages(sessionId: string, limit = 200, beforeSeq?: number) {
    return this.rpc.call('messages.load', { sessionId, limit, beforeSeq })
  }
  loadSubagentMessages(sessionId: string, parentCallId: string, afterSeq?: number, limit = SUBAGENT_STEPS_PAGE) {
    return this.rpc.call('messages.subagent', { sessionId, parentCallId, afterSeq, limit })
  }
  subagentTrashed(sessionId: string, parentCallId: string) {
    return this.rpc.call('messages.subagentTrashed', { sessionId, parentCallId })
  }
  messageImage(sessionId: string, path: string) {
    return this.rpc.call('messages.image', { sessionId, path })
  }
  commands(sessionId: string) {
    return this.rpc.call('agents.commands', { sessionId })
  }
  usage(tool: ToolName, machine?: MachineRef, opts?: { settle?: boolean }) {
    return this.rpc.call('agents.usage', { tool, ...(opts?.settle ? { settle: true } : {}), ...on(machine) })
  }
  usageHistory(range: { from: string; to: string; groupBy: 'day' | 'hour'; by: UsageHistoryBy; tool?: ToolName }, machine?: MachineRef) {
    return this.rpc.call('usage.history', { ...range, ...on(machine) })
  }
  capabilities(tool: ToolName, machine?: MachineRef) {
    return this.rpc.call('agents.capabilities', { tool, ...on(machine) })
  }
  detect(machine?: MachineRef) {
    return this.rpc.call('agents.detect', { ...on(machine) })
  }
  installTool(tool: ToolName, machine?: MachineRef) {
    return this.rpc.call('agents.installTool', { tool, ...on(machine) })
  }
  cancelInstallTool(tool: ToolName, machine?: MachineRef) {
    return this.rpc.call('agents.cancelInstallTool', { tool, ...on(machine) })
  }
  signInTool(tool: ToolName) {
    return this.rpc.call('agents.signIn', { tool })
  }
  cancelSignInTool(tool: ToolName) {
    return this.rpc.call('agents.cancelSignIn', { tool })
  }
  versions(force = false, machine?: MachineRef) {
    return this.rpc.call('agents.versions', { force, ...on(machine) })
  }
  setAutoApplyVersions(enabled: boolean, machine?: MachineRef) {
    return this.rpc.call('agents.setAutoApplyVersions', { enabled, ...on(machine) })
  }
  applyVersions(machine?: MachineRef) {
    return this.rpc.call('agents.applyVersions', { ...on(machine) })
  }
  sleepPolicy() {
    return this.rpc.call('agents.sleepPolicy', {})
  }
  setSleepPolicy(afterMinutes: number | null) {
    return this.rpc.call('agents.setSleepPolicy', { afterMinutes })
  }
  subscribe(handler: (e: NormalizedEvent, id?: string) => void): Unsubscribe {
    return this.rpc.onEvent(handler)
  }
  onConnectionChange(handler: (s: ConnectionState) => void): Unsubscribe {
    return this.rpc.onConnectionChange(handler)
  }
}

class WebProjectPort implements ProjectPort {
  constructor(private rpc: RpcClient) {}
  reorder(orderedIds: string[]) {
    return this.rpc.call('projects.reorder', { orderedIds })
  }
  add(path: string, machine?: MachineRef) {
    return this.rpc.call('projects.add', { path, ...on(machine) })
  }
  create(name: string, parent?: string, machine?: MachineRef, source?: GitSource) {
    return this.rpc.call('projects.create', { name, ...(parent ? { parent } : {}), ...(source ? { source } : {}), ...on(machine) })
  }
  createPreview(name: string, parent?: string, machine?: MachineRef, source?: GitSource) {
    return this.rpc.call('projects.createPreview', { name, ...(parent ? { parent } : {}), ...(source ? { source } : {}), ...on(machine) })
  }
  list() {
    return this.rpc.call('projects.list', {})
  }
  gitStatus(projectId: string) {
    return this.rpc.call('projects.gitStatus', { projectId })
  }
  remove(projectId: string) {
    return this.rpc.call('projects.delete', { projectId })
  }
  deleteOutlook(projectId: string) {
    return this.rpc.call('projects.deleteOutlook', { projectId })
  }
  setCommands(projectId: string, commands: SavedCommand[]) {
    return this.rpc.call('projects.setCommands', { projectId, commands })
  }

  setWorktreeTrunk(projectId: string, baseBranch: string) {
    return done(this.rpc.call('worktrees.setTrunk', { projectId, baseBranch }))
  }
  setAgentInstructions(projectId: string, text: string) {
    return done(this.rpc.call('projects.setAgentInstructions', { projectId, text }))
  }
  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null) {
    return done(this.rpc.call('projects.setWorktreeSetup', { projectId, setup }))
  }
  setTrusted(projectId: string, trusted: boolean) {
    return done(this.rpc.call('projects.setTrusted', { projectId, trusted }))
  }
}

let askedNotifications = false

/**
 * Why a notification cannot be shown, or null. Asked only while undecided and once a page: a notice comes from a
 * host event, not a click, and Safari and Firefox refuse a request outside a gesture; Chrome blocks a page that keeps
 * asking.
 */
async function notificationRefusal(): Promise<string | null> {
  if (typeof Notification === 'undefined') return 'This browser has no notifications — use the desktop app'
  if (Notification.permission === 'default' && !askedNotifications) {
    askedNotifications = true
    await Promise.resolve(Notification.requestPermission()).catch(() => 'default')
  }
  if (Notification.permission === 'granted') return null
  return Notification.permission === 'denied'
    ? "Notifications are blocked for this page — allow them in the browser's site settings"
    : "Notifications are not allowed for this page yet — allow them in the browser's site settings"
}

/** What a browser cannot do is refused with the reason and where to go instead, never resolved as if done */
class WebSystemPort implements SystemPort {
  private warned = false

  /** Says once, as the desktop's does, when it cannot notify */
  async notify(title: string, body: string) {
    const reason = await notificationRefusal()
    if (reason === null) {
      new Notification(title, { body })
      return
    }
    if (this.warned) return
    this.warned = true
    throw new Error(reason)
  }
  async alert(_kind: AlertKind, _sound: boolean) {
    // No dock, and autoplay policy routinely blocks a sound, so the dev build passes this quietly
  }
  async setBadge(_count: number) {
    /* A browser has no dock badge */
  }
  async windowAction(): Promise<void> {
    throw new Error('A browser tab has no app window to minimize, maximize or close')
  }
  async startWindowDrag(): Promise<void> {
    // A browser has no window to move
  }
  async setWindowAppearance(): Promise<void> {
    // A browser follows the OS on its own, and the page paints its own floor
  }

  async pickDirectory(): Promise<string | null> {
    return window.prompt('Enter the full path of the project directory', '')
  }
  async pickFile(opts: { title: string; extensions: string[] }): Promise<string | null> {
    // A browser's file selection gives no path the host can read
    return window.prompt(`${opts.title} — enter the full path (${opts.extensions.map((e) => `.${e}`).join(', ')})`, '')
  }
  async openInIde(_path: string, _line?: number) {
    throw new Error('A browser cannot open an IDE — use the desktop app')
  }
  /** With `noopener`, `window.open` answers null even when the tab opened, hiding a blocked pop-up; cut off after */
  async openUrl(url: string) {
    const tab = window.open(url, '_blank')
    if (!tab) throw new Error('The browser blocked the new tab — allow pop-ups for this page')
    tab.opener = null
  }
  onAppLink(_cb: (link: string) => void): () => void {
    // No OS hands links to a browser
    return () => {}
  }
}

const NO_DESKTOP_TRASH = 'A browser has no trash — use the desktop app to delete files'
const NO_DESKTOP_REVEAL = 'A browser cannot open a file manager — use the desktop app'

/**
 * The app's answer exactly as it is: a screen reads `structuredContent` and `_meta` too (the MCP Apps spec). A call
 * that never reached the app becomes a failed tool result with the host's reason, which the screen's SDK takes as a
 * result, not a throw.
 */
function viewToolResult(r: { text: string; isError?: boolean; result?: unknown }): AppToolResult {
  const raw = r.result
  if (isAppToolResult(raw)) return raw
  return { content: [{ type: 'text', text: r.text }], isError: true }
}

export function createWebPlatform(opts: WebPlatformOptions): Platform {
  const url = new URL(opts.hostUrl ?? 'ws://127.0.0.1:5175')
  const rpc = new RpcClient({ url: url.toString(), token: opts.token, WebSocketImpl: opts.WebSocketImpl, ...(opts.devTabKey ? { devTabKey: opts.devTabKey } : {}) })
  opts.onRpcClient?.(rpc)
  rpc.connect()

  const unsubscribeEndpoint = opts.onEndpointChange?.((next) => {
    rpc.updateEndpoint(`ws://127.0.0.1:${next.port}`, next.token)
  })

  return {
    agents: new WebAgentPort(rpc),
    apps: {
      // The host makes the address and the secret; this side only reports the calling screen's origin
      viewFrame: (appId, instanceId, { projectId = null, hostOrigin }) =>
        rpc.call('apps.viewFrame', { appId, projectId, instanceId, hostOrigin }),
      // One call path (docs/apps/trust-lifecycle-calls.md). `projectId` is always sent, null for a user-folder app: a
      // host before #372 reads a call without it as a person calling a built-in app, a door a screen's code must never
      // use. Only `instanceId`'s screen skips the "changed" this call produces.
      callTool: async (appId, tool, args, from) =>
        viewToolResult(await rpc.call('apps.invoke', { appId, name: tool, args, projectId: from?.projectId ?? null, instanceId: from?.instanceId })),
      readResource: (appId, uri, from) =>
        rpc.call('apps.readResource', { appId, projectId: from?.projectId ?? null, uri, instanceId: from?.instanceId }),
      list: () => rpc.call('apps.list', {}),
      openView: async (appId, projectId, machine, openKey, recover = false) => {
        // Leased to this window's connection (#392): a reload or a closed window lets the host close it
        const params = { appId, projectId, ...(machine ? { machine } : {}), lease: true }
        const v = recover && openKey
          ? await rpc.call('apps.recoverView', { ...params, openKey })
          : await rpc.call('apps.openView', { ...params, ...(openKey ? { openKey } : {}) })
        // A result the screen cannot read is a failed one, not a crash there
        return isAppToolResult(v.toolResult) ? v : { ...v, toolResult: viewToolResult({ text: 'The app answered with a result this window cannot read' }) }
      },
      closeView: (instanceId) => done(rpc.call('apps.closeView', { instanceId })),
      holdViews: async (instanceIds) => (await rpc.call('apps.holdViews', { instanceIds })).missing,
      sendViewMessage: (sessionId, instanceId, text) => done(rpc.call('apps.viewMessage', { sessionId, instanceId, text })),
      inlineViews: (sessionId) => rpc.call('apps.inlineViews', { sessionId }),
      reopenInlineView: async (sessionId, callId) => {
        const { toolResult, ...v } = await rpc.call('apps.inlineReopen', { sessionId, callId })
        return { ...v, ...(isAppToolResult(toolResult) ? { toolResult } : {}) }
      },
      restart: (appId, projectId, machine) => done(rpc.call('apps.restart', { appId, projectId, ...on(machine) })),
      runs: (appId, projectId, limit, machine) => rpc.call('apps.runs', { appId, projectId, limit, ...on(machine) }),
      remove: (appId, projectId, machine) => done(rpc.call('apps.remove', { appId, projectId, ...on(machine) })),
      create: (spec) => rpc.call('apps.create', spec),
      builder: (appId, projectId, machine) => rpc.call('apps.builder', { appId, projectId, ...on(machine) }),
      createBuilder: (appId, projectId, tool, machine) => rpc.call('apps.createBuilder', { appId, projectId, ...(tool ? { tool } : {}), ...on(machine) }),
      askBuilder: (req) => rpc.call('apps.askBuilder', req),
      errors: (appId, projectId, machine) => rpc.call('apps.errors', { appId, projectId, ...on(machine) }),
      reach: (sessionId, appId, projectId) => rpc.call('apps.reach', { sessionId, appId, projectId }),
      sendError: (appId, projectId, at, machine) => rpc.call('apps.sendError', { appId, projectId, at, ...on(machine) }),
      questions: () => rpc.call('apps.questions', {}),
      answerQuestion: (questionId, decision) => done(rpc.call('apps.answerQuestion', { questionId, decision })),
      permissions: (appId, projectId, machine) => rpc.call('apps.permissions', { appId, projectId, ...on(machine) }),
      forgetPermission: (appId, projectId, capability, machine) => done(rpc.call('apps.forgetPermission', { appId, projectId, capability, ...on(machine) })),
      usage: (appId, projectId, machine) => rpc.call('apps.usage', { appId, projectId, ...on(machine) }),
      setShared: (appId, projectId, shared) => done(rpc.call('apps.setShared', { appId, projectId, shared })),
      setOff: (appId, projectId, off) => done(rpc.call('apps.setOff', { appId, projectId, off })),
      setSecret: (appId, projectId, name, value, machine) => done(rpc.call('apps.setSecret', { appId, projectId, name, value, ...on(machine) })),
      importPrepare: (source) => rpc.call('apps.importPrepare', { source }),
      importCommit: (token, { enable, reviewKey, parent }) =>
        rpc.call('apps.importCommit', { token, enable, ...(reviewKey !== undefined ? { reviewKey } : {}), ...(parent ? { parent } : {}) }),
      importCancel: (token) => done(rpc.call('apps.importCancel', { token })),
      review: (appId, projectId) => rpc.call('apps.review', { appId, projectId }),
      enable: (appId, projectId, reviewKey) => rpc.call('apps.enable', { appId, projectId, reviewKey }),
      versions: (appId, projectId, machine) => rpc.call('apps.versions', { appId, projectId, ...on(machine) }),
      restoreVersion: (appId, projectId, id, machine) => rpc.call('apps.restoreVersion', { appId, projectId, id, ...on(machine) }),
    },
    projects: new WebProjectPort(rpc),
    system: new WebSystemPort(),
    search: {
      messages: (query, limit) => rpc.call('messages.search', { query, limit }),
    },
    rules: {
      list: () => rpc.call('approvals.rules', {}),
      remove: (id) => done(rpc.call('approvals.deleteRule', { id })),
    },
    consents: {
      list: () => rpc.call('projectConsents.list', {}),
      revoke: (fromProjectId, toProjectId, kind) => done(rpc.call('projectConsents.revoke', { fromProjectId, toProjectId, kind })),
    },
    mail: {
      list: () => rpc.call('mail.list', {}),
      tasks: () => rpc.call('mail.tasks', {}),
      thread: (threadId, opts) => rpc.call('mail.thread', { threadId, ...opts }),
      reply: (threadId, text, kind, answers) => rpc.call('mail.reply', { threadId, text, ...(kind ? { kind } : {}), ...(answers ? { answers } : {}) }),
      close: (threadId, outcome) => rpc.call('mail.close', { threadId, ...(outcome ? { outcome } : {}) }),
      held: (action, recipient, messageIds) => rpc.call('mail.held', { action, recipient, messageIds }),
      resume: (target) => done(rpc.call('mail.resume', target)),
      wake: (wake) => done(rpc.call('mail.wake', { wake })),
      watches: (sessionId) => rpc.call('watches.list', { sessionId }).then((r) => r.watches),
      cancelWatch: (id) => rpc.call('watches.cancel', { id }).then((r) => r.cancelled),
    },
    trash: {
      list: () => rpc.call('trash.list', {}),
      read: (sessionId, limit, beforeSeq) => rpc.call('trash.read', { sessionId, limit, beforeSeq }),
      restore: (sessionId) => rpc.call('trash.restore', { sessionId }),
      purge: (sessionId) => done(rpc.call('trash.purge', { sessionId })),
      empty: () => rpc.call('trash.empty', {}),
      readRun: (runId, limit, beforeSeq, machine) => rpc.call('trash.readRun', { runId, limit, beforeSeq, ...(machine ? { machine } : {}) }),
      purgeRuns: (runIds, machine) => rpc.call('trash.purgeRuns', { runIds, ...(machine ? { machine } : {}) }),
      subagentUsage: () => rpc.call('subagents.usage', {}),
      trashSubagentSteps: (sessionId) => rpc.call('subagents.trash', { sessionId }),
      restoreSubagentSteps: (sessionId) => done(rpc.call('trash.restoreSubagentSteps', { sessionId })),
      purgeSubagentSteps: (sessionId, upTo) => done(rpc.call('trash.purgeSubagentSteps', { sessionId, upTo })),
    },
    fs: {
      search: (projectId, query, limit) => rpc.call('files.search', { projectId, query, limit }),
      listDir: (projectId, path) => rpc.call('fs.listDir', { projectId, path }),
      watch: (projectId, paths) => rpc.call('fs.watch', { projectId, paths }),
      readFile: (projectId, path, sessionId) => rpc.call('fs.readFile', { projectId, path, ...(sessionId ? { sessionId } : {}) }),
      resolve: (projectId, path, sessionId) => rpc.call('fs.resolve', { projectId, path, ...(sessionId ? { sessionId } : {}) }),
      move: (projectId, from, toDir) => rpc.call('fs.move', { projectId, from, toDir }),
      importFile: (projectId, toDir, name, dataBase64) =>
        rpc.call('fs.importFile', { projectId, toDir, name, dataBase64 }),
      // Two steps: the host, which knows the root and is the one place that decides what is outside it, makes the
      // absolute path; the shell hands it to the OS
      trash: async (projectId, path) => {
        if (!opts.nativeFiles) return { supported: false, reason: NO_DESKTOP_TRASH }
        // The entry itself, a link included, never what it points at (#838)
        const { path: abs } = await rpc.call('fs.resolve', { projectId, path, purpose: 'trash' })
        await opts.nativeFiles.trash(abs)
        return { supported: true }
      },
      trashProjectFolder: async (projectId) => {
        if (!opts.nativeFiles) return { supported: false, reason: NO_DESKTOP_TRASH }
        const { path: abs } = await rpc.call('fs.resolve', { projectId, path: '.', purpose: 'project' })
        await opts.nativeFiles.trash(abs)
        return { supported: true }
      },
      reveal: async (projectId, path, sessionId) => {
        if (!opts.nativeFiles) return { supported: false, reason: NO_DESKTOP_REVEAL }
        const { path: abs } = await rpc.call('fs.resolve', { projectId, path, purpose: 'reveal', ...(sessionId ? { sessionId } : {}) })
        await opts.nativeFiles.reveal(abs)
        return { supported: true }
      },
      // The host already resolved this one when it read the image; the shell still refuses a relative or linked path
      revealMessageImage: async (file) => {
        if (!opts.nativeFiles) return { supported: false, reason: NO_DESKTOP_REVEAL }
        await opts.nativeFiles.reveal(file)
        return { supported: true }
      },
      revealMessageFile: async (sessionId, path) => {
        if (!opts.nativeFiles) return { supported: false, reason: NO_DESKTOP_REVEAL }
        const res = await rpc.call('messages.resolveFile', { sessionId, path })
        if (!res.ok) throw new Error(res.message)
        await opts.nativeFiles.reveal(res.file)
        return { supported: true }
      },
    },
    git: {
      status: (projectId) => rpc.call('git.status', { projectId }),
      diff: (projectId, path, staged) => rpc.call('git.diff', { projectId, path, staged }),
      log: (projectId, limit) => rpc.call('git.log', { projectId, limit }),
      commitDetail: (projectId, sha) => rpc.call('git.commitDetail', { projectId, sha }),
      branches: (projectId) => rpc.call('git.branches', { projectId }),
      ignoredEntries: (projectId) => rpc.call('git.ignoredEntries', { projectId }),
      checkout: (projectId, branch, dryRun) => rpc.call('git.checkout', { projectId, branch, dryRun }),
      stage: (projectId, paths, unstage) => done(rpc.call('git.stage', { projectId, paths, unstage })),
      commit: (projectId, message) => rpc.call('git.commit', { projectId, message }),
      push: (projectId) => rpc.call('git.push', { projectId }),
      cancel: (projectId) => rpc.call('git.cancel', { projectId }),
    },
    terminal: {
      list: async (projectId) =>
        (await rpc.call('terminal.list', { projectId })).terminals,
      create: (projectId, cols, rows) => rpc.call('terminal.create', { projectId, cols, rows }),
      close: (terminalId) => done(rpc.call('terminal.close', { terminalId })),
      input: (terminalId, data) => done(rpc.call('terminal.input', { terminalId, data })),
      resize: (terminalId, cols, rows) => done(rpc.call('terminal.resize', { terminalId, cols, rows })),
      restart: (terminalId, cols, rows) => rpc.call('terminal.restart', { terminalId, cols, rows }),
      onOutput: (h) => rpc.onTerminalOutput(h),
      onExit: (h) => rpc.onTerminalExit(h),
    },
    // Output rides on terminal.onOutput/onExit
    commands: {
      run: (projectId, command, cols, rows) => rpc.call('commands.run', { projectId, command, cols, rows }),
      stop: (projectId, command) => done(rpc.call('commands.stop', { projectId, command })),
      state: async (projectId) => (await rpc.call('commands.state', { projectId })).runs,
      log: async (projectId, command) => (await rpc.call('commands.log', { projectId, command })).run,
      resize: (projectId, command, cols, rows) => done(rpc.call('commands.resize', { projectId, command, cols, rows })),
    },
    // Leftover processes running from Centralu's folders, which the quit modal asks about
    processes: {
      strays: () => rpc.call('processes.strays', {}),
      stop: (pids) => rpc.call('processes.stop', { pids }),
    },
    machines: {
      list: () => rpc.call('machines.list', {}),
      add: (spec) => rpc.call('machines.add', spec),
      sshHosts: () => rpc.call('machines.sshHosts', {}),
      probe: (sshTarget) => rpc.call('machines.probe', { sshTarget }),
      remove: (machineId) => done(rpc.call('machines.remove', { machineId })),
      reconnect: (machineId) => rpc.call('machines.reconnect', { machineId }),
      disconnect: (machineId) => rpc.call('machines.disconnect', { machineId }),
      revokeCredential: (machineId, credentialId) => rpc.call('machines.revokeCredential', { machineId, credentialId }),
      setAutoReconnect: (machineId, autoReconnect) => rpc.call('machines.setAutoReconnect', { machineId, autoReconnect }),
      acceptVersions: (machineId) => rpc.call('machines.acceptVersions', { machineId }),
      install: (machineId) => rpc.call('machines.install', { machineId }),
      update: (machineId, opts) => rpc.call('machines.update', opts?.when ? { machineId, when: opts.when } : { machineId }),
      cancelUpdate: (machineId) => rpc.call('machines.cancelUpdate', { machineId }),
      rollback: (machineId) => rpc.call('machines.rollback', { machineId }),
      uninstall: (machineId) => rpc.call('machines.uninstall', { machineId }),
      autostart: (machineId, on) => rpc.call('machines.autostart', on === undefined ? { machineId } : { machineId, on }),
      activity: async (machineId) => (await rpc.call('machines.activity', { machineId })).activity,
      hubAuto: async (machineId, allowed) => (await rpc.call('machines.hubAuto', { machineId, ...(allowed === undefined ? {} : { allowed }) })).state,
      setAsks: (machineId, on) => rpc.call('machines.setAsks', { machineId, on }),
      askConsents: () => rpc.call('machines.askConsents', {}),
      withdrawAsk: (machineId, sessionId, projectId) => done(rpc.call('machines.withdrawAsk', { machineId, sessionId, projectId })),
    },
    workspace: {
      save: (snapshot) => done(rpc.call('workspace.save', { layout: snapshot })),
      async load() {
        return await rpc.call('workspace.load', {})
      },
    },
    // Preferences live in the host's store, not browser storage: the dev server and the app would differ, and clearing
    // the cache would clear them
    themes: {
      list: () => rpc.call('themes.list', {}),
      save: (id, content) => rpc.call('themes.save', { id, content }),
      importFile: (path) => rpc.call('themes.import', { path }),
      // The same two steps as fs.trash
      remove: async (id) => {
        if (!opts.nativeFiles) return { supported: false, reason: NO_DESKTOP_TRASH }
        const { path } = await rpc.call('themes.resolve', { id })
        await opts.nativeFiles.trash(path)
        return { supported: true }
      },
      reveal: async (id) => {
        if (!opts.nativeFiles) return { supported: false, reason: NO_DESKTOP_REVEAL }
        const { path } = await rpc.call('themes.resolve', { id })
        await opts.nativeFiles.reveal(path)
        return { supported: true }
      },
    },
    prefs: {
      load: () => rpc.call('prefs.get', {}),
      save: (patch) => rpc.call('prefs.set', { patch }),
    },
    // The host's, in Tauri too: `npm i -g` is Node's job, and progress rides the event stream as `update_status`
    updates: {
      status: (force = false) => rpc.call('updates.status', { force }),
      setAuto: (enabled) => rpc.call('updates.setAuto', { enabled }),
      setAutoApply: (enabled) => rpc.call('updates.setAutoApply', { enabled }),
      apply: () => rpc.call('updates.apply', {}),
      answerApply: (a) => rpc.call('updates.answerApply', a),
      reportApply: async (r) => void (await rpc.call('updates.reportApply', r)),
    },
    diagnostics: { reportCrash: (r) => rpc.call('ui.reportCrash', r).then(() => undefined) },
    requests: {
      list: () => rpc.call('requests.list', {}),
      answer: (requestId, decision) => rpc.call('requests.answer', { requestId, decision }),
      devTabs: () => rpc.call('host.devTabs', {}),
      revokeDevTab: async (id) => {
        await rpc.call('host.revokeDevTab', { id })
      },
    },
    capabilities: defaultCapabilities(opts.capabilities),
    async dispose() {
      unsubscribeEndpoint?.()
      rpc.close()
    },
  }
}

export { RpcClient }
