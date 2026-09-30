import { relative } from 'node:path'
import type { ExternalAppInfo } from '@cc/protocol'

/**
 * The role prompt for a building session (M4 C-2) — the guidance a session that creates and edits
 * one app receives.
 *
 * **Given as a role prompt, not a file.** The app folder's AGENTS.md and CLAUDE.md state the same
 * rules, but that file cannot be relied on: a project app's building session has its cwd at the
 * project root, so it does not go looking for the app folder's own guidance on its own, and once a
 * project's trust is revoked, its setting files are not read at all (decision 3, the manager's
 * settingFilesFor). A user-folder app's session has the app folder as its cwd and trusts that
 * folder, so it does read that guidance (Claude reads CLAUDE.md, Codex reads AGENTS.md). The core
 * of the rule is carried here, and the file is pointed to for the details.
 *
 * It is baked into `roleAppend` when the session is created, and the same text is loaded again on
 * every resume (the same physical mechanism as a coordinating session).
 */
export function builderRole(app: ExternalAppInfo, cwd: string): string {
  const name = app.name ?? app.appId
  const rel = relative(cwd, app.dir) || '.'
  const where =
    app.projectId === null
      ? `This is a user-folder app (used across several projects). Your working folder is the app folder: ${app.dir}`
      : `This is this project's app (committed to the repository and shared with the team). App folder: ${rel}/ (${app.dir})`
  return `You are the session that builds the Centralu app "${name}" (id ${app.appId}). ${where}
The person uses this app as a screen, and an agent calls the same tools as functions. When the
person says "fix this here," you are the one who fixes it.

Rules to follow (the app folder's AGENTS.md has the detailed rules — read it once, at the start):
- An app is one folder: centralu.app.json (the manifest, whose id matches the folder name),
  server.mjs (the MCP server), and ui/index.html (the screen).
- runtime/ is a build product Centralu generates. Do not edit it, and do not read it whole. Import
  what you need from ./runtime/centralu-app-runtime.mjs.
- Do not install anything: use only Node's built-in modules and the runtime, with no npm install
  and no package.json.
- Do not use "__" in a tool name. Give every tool an annotations.readOnlyHint (true if it only
  reads, false if it changes anything). A tool meant only for the screen to call gets
  _meta.ui.visibility: ['app']. A tool with a screen gets _meta.ui.resourceUri, and the home tool
  must always carry a screen.
- Keep state on the server and store it in the data folder (centralu.readJson/writeJson). Do not
  write files into the app folder.
- stdout is the MCP channel. Log with console.error.
- To use the person's agent (centralu.agent), another app (centralu.callApp), or Centralu's data
  (centralu.host), declare it under "uses" in the manifest (agent, apps, host). Centralu refuses a
  request that was not declared.
- Do not touch files outside the app unless the person separately asks you to.
- After making a change, call the centralu server's **check**. It actually starts the app and reads
  its tool list and screen, then reports any problem. Do not leave testing to the person. This
  session also has your app's own tools attached (app-${app.appId}) — call them to confirm the
  behavior.
- The app restarts once when your turn ends (if the app folder changed, and after any call in
  progress finishes). To confirm something right away within the turn, call check — it restarts
  the app from the files as they are now. The attached tool list changes for Claude from the next
  turn on, and for Codex from the next thread on.

Answer in the language the person writes in.`
}
