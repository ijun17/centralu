import type {
  Attachment,
  ApprovalDecision,
  ApprovalScope,
  CreateSessionParams,
  NormalizedEvent,
  SavedCommand,
  ToolName,
  QuestionAnswer,
  UpdateSettingsParams,
} from '@cc/protocol'
import type {
  AgentPort,
  AlertKind,
  AppToolResult,
  ConnectionState,
  Platform,
  ProjectPort,
  SystemPort,
  Unsubscribe,
  WorkspaceSnapshot,
} from '../ports/index.js'
import { RpcClient } from './rpc-client.js'

/**
 * The browser (dev) implementation. Most of it is "delegate to the host over WS" —
 * step 1 of the Tauri transition reuses this implementation as-is (docs/platform-abstraction.md §5).
 */
export type WebPlatformOptions = {
  /** A subscription that reports a new port and token when the host restarts (injected by Tauri) */
  onEndpointChange?: (cb: (info: { port: number; token: string }) => void) => Unsubscribe
  hostUrl?: string
  token: string
  WebSocketImpl?: typeof WebSocket
  /**
   * The desktop shell's own file operations, injected by the Tauri build (#18/#19).
   *
   * Trashing and revealing are the two things the Node host cannot do — a real OS trash is
   * `NSFileManager trashItem` / the freedesktop spec, not an unlink into a temp folder — so
   * they belong to Rust. Absent here means "there is no desktop under this page", which is
   * exactly the browser's situation, and the port answers `supported: false` for it rather
   * than pretending.
   */
  nativeFiles?: {
    trash(absPath: string): Promise<void>
    reveal(absPath: string): Promise<void>
  }
  /** Answered by the shell, for the same reason as the keyboard labels — a browser has no file manager to ask */
  fileManagerName?: string
}

class WebAgentPort implements AgentPort {
  constructor(private rpc: RpcClient) {}
  createSession(params: CreateSessionParams) {
    return this.rpc.call('agents.createSession', params)
  }
  async send(sessionId: string, text: string, attachments?: Attachment[]) {
    await this.rpc.call('agents.send', { sessionId, text, attachments })
  }
  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string) {
    return this.rpc.call('attachments.save', { sessionId, name, mime, dataBase64 })
  }
  async respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    matcher?: string,
  ) {
    await this.rpc.call('agents.respondApproval', { sessionId, requestId, decision, scope, matcher })
  }
  async answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]) {
    await this.rpc.call('agents.answerQuestion', { sessionId, requestId, answers })
  }
  reorderSessions(projectId: string, orderedIds: string[]) {
    return this.rpc.call('sessions.reorder', { projectId, orderedIds })
  }

  orchestrator() {
    return this.rpc.call('orchestrator.get', {})
  }
  orchestratorPeek() {
    return this.rpc.call('orchestrator.peek', {})
  }
  async configureOrchestrator(tool: ToolName) {
    await this.rpc.call('orchestrator.configure', { tool })
  }
  switchTool(sessionId: string, tool: ToolName) {
    return this.rpc.call('agents.switchTool', { sessionId, tool })
  }
  grid() {
    return this.rpc.call('grid.get', {})
  }

  setGridView(sessionIds: string[]) {
    return this.rpc.call('grid.set', { sessionIds })
  }

  models(tool: ToolName) {
    return this.rpc.call('agents.models', {
      tool,
    })
  }

  async interrupt(sessionId: string) {
    await this.rpc.call('agents.interrupt', { sessionId })
  }
  restartSession(sessionId: string) {
    return this.rpc.call('agents.restartSession', {
      sessionId,
    })
  }
  /*
   * Uses exactly the same type as the port (Omit<UpdateSettingsParams,'sessionId'>).
   * Writing this out by hand once **worked even with effort missing** — because TS does not
   * check for excess properties when the store passes a variable (the commands.ts incident).
   * Uses only the one named type from protocol, so the type cannot lie — cleaned up while
   * adding verbosity (#54).
   */
  updateSettings(sessionId: string, settings: Omit<UpdateSettingsParams, 'sessionId'>) {
    return this.rpc.call('agents.updateSettings', { sessionId, ...settings })
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
  async resolveMcpProposal(name: string, approve: boolean) {
    await this.rpc.call('agents.resolveMcpProposal', { name, approve })
  }
  async skillProposals() {
    return this.rpc.call('agents.skillProposals', {})
  }
  async resolveSkillProposal(name: string, approve: boolean) {
    await this.rpc.call('agents.resolveSkillProposal', { name, approve })
  }
  async orchestratorSkills() {
    return this.rpc.call('agents.orchestratorSkills', {})
  }
  async deleteOrchestratorSkill(name: string) {
    await this.rpc.call('agents.deleteOrchestratorSkill', { name })
  }

  async deleteSession(sessionId: string, deleteWorktree = false, deleteExternal = false) {
    await this.rpc.call('agents.deleteSession', { sessionId, deleteWorktree, deleteExternal })
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
  async rename(sessionId: string, name: string) {
    await this.rpc.call('sessions.rename', { sessionId, name })
  }
  async markRead(sessionId: string, seq: number) {
    await this.rpc.call('sessions.markRead', { sessionId, seq })
  }
  listSessions() {
    return this.rpc.call('sessions.list', {})
  }
  loadMessages(sessionId: string, limit = 200, beforeSeq?: number) {
    return this.rpc.call('messages.load', { sessionId, limit, beforeSeq })
  }
  commands(sessionId: string) {
    return this.rpc.call('agents.commands', { sessionId })
  }
  usage(tool: ToolName) {
    return this.rpc.call('agents.usage', {
      tool,
    })
  }
  capabilities(tool: ToolName) {
    return this.rpc.call('agents.capabilities', { tool })
  }
  detect() {
    return this.rpc.call('agents.detect', {})
  }
  subscribe(handler: (e: NormalizedEvent) => void): Unsubscribe {
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
  add(path: string) {
    return this.rpc.call('projects.add', { path })
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
  setCommands(projectId: string, commands: SavedCommand[]) {
    return this.rpc.call('projects.setCommands', { projectId, commands })
  }

  createWorktreeManager(projectId: string, baseBranch: string) {
    return this.rpc.call('worktrees.createManager', { projectId, baseBranch })
  }
  async setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null) {
    await this.rpc.call('projects.setWorktreeSetup', { projectId, setup })
  }
  async setTrusted(projectId: string, trusted: boolean) {
    await this.rpc.call('projects.setTrusted', { projectId, trusted })
  }
}

/** The web fallback — since the capability is false, the UI hides the feature on its own */
class WebSystemPort implements SystemPort {
  async notify(title: string, body: string) {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'granted') new Notification(title, { body })
  }
  async alert(_kind: AlertKind, sound: boolean) {
    // A browser has no dock. Sound can be played, but it is routinely blocked by autoplay
    // policy, so it cannot be trusted as "the notification that sometimes rings" — the web
    // build is for dev, so this passes through quietly.
    void sound
  }
  async setBadge(_count: number) {
    /* A browser has no dock badge */
  }
  async startWindowDrag(): Promise<void> {
    // A browser has no window to move
  }

  async pickDirectory(): Promise<string | null> {
    // A browser has no directory picker — a dev-only fallback
    return window.prompt('Enter the full path of the project directory', '')
  }
  async pickFile(opts: { title: string; extensions: string[] }): Promise<string | null> {
    // The same fallback as the directory picker — a browser's file selection gives no path (the host needs a path it can read)
    return window.prompt(`${opts.title} — enter the full path (${opts.extensions.map((e) => `.${e}`).join(', ')})`, '')
  }
  async openInIde(_path: string, _line?: number) {
    /* Only on Tauri (the UI disables this via capability) */
  }
  async openUrl(url: string) {
    // In a browser this is simply opening it outside — a new tab, so it never touches this app's own work
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  onAppLink(_cb: (link: string) => void): () => void {
    // A browser has no OS handing links to this app (M4 E-4) — those only arrive on desktop
    return () => {}
  }
}

/*
  The reasons for the two things a browser cannot do. **Never just ends at "cannot."** Says why
  it cannot, and where to go instead (the same as `models()` attaching a reason to supported=false).
*/
const NO_DESKTOP_TRASH = 'A browser has no trash — use the desktop app to delete files'
const NO_DESKTOP_REVEAL = 'A browser cannot open a file manager — use the desktop app'

/**
 * `apps.invoke`'s response → the MCP result the screen receives.
 *
 * If the app answered, gives that answer **exactly as it is**. `structuredContent`, `isError`
 * and `_meta` all belong to the screen too (per spec: a screen receives a tool result).
 * Wrapping it down into text would leave a screen that reads state from `structuredContent`
 * empty-handed. A call that could not reach the app (rejected by the host, failed to start,
 * cancelled) has no answer from the app — in that case, gives the reason the host wrote as a
 * failed tool result. The screen's SDK receives this as a result, not as a thrown error.
 */
function viewToolResult(r: { text: string; isError?: boolean; result?: unknown }): AppToolResult {
  const raw = r.result
  if (raw && typeof raw === 'object' && Array.isArray((raw as { content?: unknown }).content)) return raw as AppToolResult
  return { content: [{ type: 'text', text: r.text }], isError: true }
}

export function createWebPlatform(opts: WebPlatformOptions): Platform {
  const url = new URL(opts.hostUrl ?? 'ws://127.0.0.1:5175')
  const rpc = new RpcClient({ url: url.toString(), token: opts.token, WebSocketImpl: opts.WebSocketImpl })
  rpc.connect()

  // If the host restarts, switches to the new address (the Tauri supervisor reports it)
  const unsubscribeEndpoint = opts.onEndpointChange?.((next) => {
    rpc.updateEndpoint(`ws://127.0.0.1:${next.port}`, next.token)
  })

  return {
    agents: new WebAgentPort(rpc),
    // App state (#81) — a thin carrier. Only the app knows what the document means
    apps: {
      state: (appId) => rpc.call('apps.state', { appId }),
      setState: async (appId, doc) => {
        await rpc.call('apps.setState', { appId, doc })
      },
      setEnabled: async (appId, enabled) => {
        await rpc.call('apps.setEnabled', { appId, enabled })
      },
      invoke: (appId, name, args) => rpc.call('apps.invoke', { appId, name, args }),
      // The app screen (M4 B-3). Both the address and the secret are made by the host — this side only reports the calling screen's origin
      viewFrame: (appId, instanceId, { projectId = null, hostOrigin }) =>
        rpc.call('apps.viewFrame', { appId, projectId, instanceId, hostOrigin }),
      /*
        A tool call from a screen goes through the **same door** as a call from a person
        (`apps.invoke`). Built-in and external apps go through one path, and scope and logging
        are handled together by the host's mediation (the plan's "there is one call path").

        `projectId` is always carried (null for a user-folder app). Without it, the host reads
        this as a human calling a built-in app. A screen is an external app's code, and must
        never enter through that door. `instanceId` becomes the owner of the "changed" this
        call produces — only that screen skips that notification (B-5).
      */
      callTool: async (appId, tool, args, from) =>
        viewToolResult(await rpc.call('apps.invoke', { appId, name: tool, args, projectId: from?.projectId ?? null, instanceId: from?.instanceId })),
      readResource: (appId, uri, from) =>
        rpc.call('apps.readResource', { appId, projectId: from?.projectId ?? null, uri, instanceId: from?.instanceId }),
      list: () => rpc.call('apps.list', {}),
      // The response's result is exactly the MCP result the app gave — the shape is known to the screen and the app, so this just carries it
      openView: async (appId, projectId) => {
        const v = await rpc.call('apps.openView', { appId, projectId })
        return { ...v, toolResult: v.toolResult as AppToolResult }
      },
      closeView: async (instanceId) => {
        await rpc.call('apps.closeView', { instanceId })
      },
      sendViewMessage: async (sessionId, instanceId, text) => {
        await rpc.call('apps.viewMessage', { sessionId, instanceId, text })
      },
      // The result is exactly the MCP result the app gave — carried through as with openView
      inlineViews: (sessionId) => rpc.call('apps.inlineViews', { sessionId }),
      reopenInlineView: async (sessionId, callId) => {
        const { toolResult, ...v } = await rpc.call('apps.inlineReopen', { sessionId, callId })
        return { ...v, ...(toolResult ? { toolResult: toolResult as AppToolResult } : {}) }
      },
      restart: async (appId, projectId) => {
        await rpc.call('apps.restart', { appId, projectId })
      },
      runs: (appId, projectId, limit) => rpc.call('apps.runs', { appId, projectId, limit }),
      remove: async (appId, projectId) => {
        await rpc.call('apps.remove', { appId, projectId })
      },
      create: (spec) => rpc.call('apps.create', spec),
      builder: (appId, projectId) => rpc.call('apps.builder', { appId, projectId }),
      createBuilder: (appId, projectId, tool) => rpc.call('apps.createBuilder', { appId, projectId, ...(tool ? { tool } : {}) }),
      askBuilder: (req) => rpc.call('apps.askBuilder', req),
      errors: (appId, projectId) => rpc.call('apps.errors', { appId, projectId }),
      sendError: (appId, projectId, at) => rpc.call('apps.sendError', { appId, projectId, at }),
      questions: () => rpc.call('apps.questions', {}),
      answerQuestion: async (questionId, decision) => {
        await rpc.call('apps.answerQuestion', { questionId, decision })
      },
      permissions: (appId, projectId) => rpc.call('apps.permissions', { appId, projectId }),
      forgetPermission: async (appId, projectId, capability) => {
        await rpc.call('apps.forgetPermission', { appId, projectId, capability })
      },
      usage: (appId, projectId) => rpc.call('apps.usage', { appId, projectId }),
      setSecret: async (appId, projectId, name, value) => {
        await rpc.call('apps.setSecret', { appId, projectId, name, value })
      },
      importPrepare: (source) => rpc.call('apps.importPrepare', { source }),
      importCommit: (token, { enable, reviewKey }) =>
        rpc.call('apps.importCommit', { token, enable, ...(reviewKey !== undefined ? { reviewKey } : {}) }),
      importCancel: async (token) => {
        await rpc.call('apps.importCancel', { token })
      },
      review: (appId, projectId) => rpc.call('apps.review', { appId, projectId }),
      enable: (appId, projectId, reviewKey) => rpc.call('apps.enable', { appId, projectId, reviewKey }),
      versions: (appId, projectId) => rpc.call('apps.versions', { appId, projectId }),
      restoreVersion: (appId, projectId, id) => rpc.call('apps.restoreVersion', { appId, projectId, id }),
    },
    projects: new WebProjectPort(rpc),
    system: new WebSystemPort(),
    search: {
      messages: (query, limit) => rpc.call('messages.search', { query, limit }),
    },
    rules: {
      list: () => rpc.call('approvals.rules', {}),
      remove: async (id) => {
        await rpc.call('approvals.deleteRule', { id })
      },
    },
    trash: {
      list: () => rpc.call('trash.list', {}),
      read: (sessionId, limit, beforeSeq) => rpc.call('trash.read', { sessionId, limit, beforeSeq }),
      restore: (sessionId) => rpc.call('trash.restore', { sessionId }),
      purge: async (sessionId) => {
        await rpc.call('trash.purge', { sessionId })
      },
      empty: () => rpc.call('trash.empty', {}),
    },
    fs: {
      search: (projectId, query, limit) => rpc.call('files.search', { projectId, query, limit }),
      listDir: (projectId, path) => rpc.call('fs.listDir', { projectId, path }),
      watch: (projectId, paths) => rpc.call('fs.watch', { projectId, paths }),
      readFile: (projectId, path) => rpc.call('fs.readFile', { projectId, path }),
      resolve: (projectId, path) => rpc.call('fs.resolve', { projectId, path }),
      move: (projectId, from, toDir) => rpc.call('fs.move', { projectId, from, toDir }),
      importFile: (projectId, toDir, name, dataBase64) =>
        rpc.call('fs.importFile', { projectId, toDir, name, dataBase64 }),
      /*
        The trash and "reveal in file manager" are **two steps**: get the absolute path from
        the host, which knows the project root, and hand that to the shell, which can pass it
        to the OS. This is why the UI never assembles the path itself — the place that decides
        whether something goes outside the root has to be exactly one place.
      */
      trash: async (projectId, path) => {
        if (!opts.nativeFiles) return { supported: false, reason: NO_DESKTOP_TRASH }
        const { path: abs } = await rpc.call('fs.resolve', { projectId, path })
        await opts.nativeFiles.trash(abs)
        return { supported: true }
      },
      reveal: async (projectId, path) => {
        if (!opts.nativeFiles) return { supported: false, reason: NO_DESKTOP_REVEAL }
        const { path: abs } = await rpc.call('fs.resolve', { projectId, path })
        await opts.nativeFiles.reveal(abs)
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
      stage: async (projectId, paths, unstage) => {
        await rpc.call('git.stage', { projectId, paths, unstage })
      },
      commit: (projectId, message) => rpc.call('git.commit', { projectId, message }),
      push: (projectId) => rpc.call('git.push', { projectId }),
    },
    terminal: {
      list: async (projectId) =>
        (await rpc.call('terminal.list', { projectId })).terminals,
      create: (projectId, cols, rows) => rpc.call('terminal.create', { projectId, cols, rows }),
      close: async (terminalId) => {
        await rpc.call('terminal.close', { terminalId })
      },
      input: async (terminalId, data) => {
        await rpc.call('terminal.input', { terminalId, data })
      },
      resize: async (terminalId, cols, rows) => {
        await rpc.call('terminal.resize', { terminalId, cols, rows })
      },
      restart: (terminalId, cols, rows) => rpc.call('terminal.restart', { terminalId, cols, rows }),
      onOutput: (h) => rpc.onTerminalOutput(h),
      onExit: (h) => rpc.onTerminalExit(h),
    },
    // The runner for frequently used commands (#60) — output rides on terminal.onOutput/onExit above, as-is
    commands: {
      run: (projectId, command, cols, rows) => rpc.call('commands.run', { projectId, command, cols, rows }),
      stop: async (projectId, command) => {
        await rpc.call('commands.stop', { projectId, command })
      },
      state: async (projectId) => (await rpc.call('commands.state', { projectId })).runs,
      log: async (projectId, command) => (await rpc.call('commands.log', { projectId, command })).run,
      resize: async (projectId, command, cols, rows) => {
        await rpc.call('commands.resize', { projectId, command, cols, rows })
      },
    },
    // Leftover processes still running from our folders (what the quit modal asks about)
    processes: {
      strays: () => rpc.call('processes.strays', {}),
      stop: (pids) => rpc.call('processes.stop', { pids }),
    },
    workspace: {
      async save(snapshot) {
        await rpc.call('workspace.save', { layout: snapshot })
      },
      async load() {
        return (await rpc.call('workspace.load', {})) as WorkspaceSnapshot | null
      },
    },
    /*
      Screen preferences live in the host's DB — not in browser storage.

      Keeping them in localStorage would let the dev server and the app hold different
      settings even on the same machine, and worse, clearing storage (clearing the cache)
      would become the same as clearing preferences. A value the person chose has to live
      alongside conversations and projects to survive along with them.
    */
    prefs: {
      load: () => rpc.call('prefs.get', {}),
      save: (patch) => rpc.call('prefs.set', { patch }),
    },
    /*
      Updates are entirely delegated to the host (issue #43).

      It is correct that the Tauri implementation does not override this spot — running
      `npm i -g` is Node's job, not Rust's, and checking also happens over the same WS. There
      is no separate channel for the screen to hear progress: `update_status` rides the same
      stream as every other event (agents.subscribe).
    */
    updates: {
      status: (force = false) => rpc.call('updates.status', { force }),
      setAuto: (enabled) => rpc.call('updates.setAuto', { enabled }),
      apply: () => rpc.call('updates.apply', {}),
    },
    capabilities: {
      osNotifications: typeof Notification !== 'undefined',
      dockBadge: false,
      globalShortcuts: false,
      processSupervision: false,
      openInIde: false,
      // The browser draws no window controls over our page.
      windowControlsInset: 0,
      /*
        A page could sniff the keyboard from the user agent, and deliberately does not.
        This build is the dev server and the contract-test harness, both of which run on a
        Mac, and a capability that answers differently depending on the machine running the
        suite is one the contract test cannot pin. The shipped desktop app asks Rust
        (`packages/platform/src/tauri/index.ts`), which is the answer that has to be right.
      */
      shortcutKeys: { mod: '⌘', alt: '⌥', join: '' },
      // Same reason as the keyboard above: the page does not guess. The desktop build
      // passes the shell's answer in; the browser gets the phrase that is true anywhere.
      fileManagerName: opts.fileManagerName ?? 'file manager',
    },
    async dispose() {
      unsubscribeEndpoint?.()
      rpc.close()
    },
  }
}

export { RpcClient }
