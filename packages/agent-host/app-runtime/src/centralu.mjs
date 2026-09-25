/**
 * `centralu` — the helper every app made from the Centralu template imports.
 *
 * It lives inside the vendored runtime, not in the app's own files, so the rules it keeps (run ids,
 * screens, where data goes) are in one generated file the app author never edits.
 *
 *   centralu.tool(server, name, config, handler)   register a tool; the handler runs inside the
 *                                                  incoming call's run (id, cancel signal)
 *   centralu.uiResource(server, name, uri, htmlUrl) serve a screen as an MCP App resource
 *   centralu.agent(prompt, { schema, tool })       ask Centralu's agent (over fd 3)
 *   centralu.callApp(app, tool, args)              call another app's tool (over fd 3)
 *   centralu.host(name)                            read Centralu data declared in uses.host (over fd 3)
 *   centralu.readJson / writeJson                  state files in the app's data folder
 *   centralu.dataDir                               CENTRALU_APP_DATA (outside the app folder)
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { BrokerError, RUN_META, callBroker } from './broker.mjs'

const BRIDGE_TAG = '<script src="centralu:mcp-app.js"></script>'
const APP_ID = process.env.CENTRALU_APP_ID ?? basename(process.cwd())
const runs = new AsyncLocalStorage()

/*
 * Data lives outside the app folder: project apps are committed to git, so a file written next to
 * server.mjs would be shared with the whole team. Run by hand (no CENTRALU_APP_DATA), the app gets a
 * scratch folder under the OS temp dir instead of writing into its own folder.
 */
let dataDir = process.env.CENTRALU_APP_DATA ?? null
function ensureDataDir() {
  if (!dataDir) {
    dataDir = join(tmpdir(), 'centralu-app-data', APP_ID)
    console.error(`[centralu] CENTRALU_APP_DATA is not set (running outside Centralu?) — using ${dataDir}`)
  }
  mkdirSync(dataDir, { recursive: true })
  return dataDir
}

function currentRun(what) {
  const run = runs.getStore()
  if (!run?.runId) {
    throw new BrokerError(
      `${what} can only be called while handling a tool call (inside a centralu.tool handler) — ` +
        'Centralu needs to know which call is asking.',
    )
  }
  return run
}

function textOf(result) {
  return (result?.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
}

/**
 * While a broker call waits (an agent run takes minutes), Centralu keeps it alive with progress
 * notifications. The same beat is passed up on the tool call this app is handling, when its caller
 * sent a progress token: Centralu's call to this app has a deadline of its own, and without the beat
 * it would give up on this app while the agent is still working.
 */
function relay(run) {
  return (message) => {
    if (run.progressToken === undefined || !run.notify) return
    run.beats = (run.beats ?? 0) + 1
    run
      .notify({ method: 'notifications/progress', params: { progressToken: run.progressToken, progress: run.beats, ...(message ? { message } : {}) } })
      .catch(() => {})
  }
}

async function askBroker(what, tool, args) {
  const run = currentRun(what)
  let result
  try {
    result = await callBroker(tool, args, run.runId, run.signal, relay(run))
  } catch (e) {
    throw new BrokerError(`${what} failed: ${e.message}`)
  }
  if (result?.isError) {
    const err = new BrokerError(`${what} failed: ${textOf(result) || 'Centralu returned an error with no text'}`)
    // stderr is what the person (and the builder) sees when something goes wrong
    console.error(`[centralu] ${err.message}`)
    throw err
  }
  return result
}

export const centralu = {
  RUN_META,
  UI_MIME: RESOURCE_MIME_TYPE,
  appId: APP_ID,
  get dataDir() {
    return ensureDataDir()
  },

  /**
   * Registers a tool. Same arguments as `server.registerTool`. Tools with a screen put
   * `_meta.ui.resourceUri` in the config; tools without one are plain MCP tools.
   * A handler that throws is logged to stderr with its stack, then reported to the caller.
   */
  tool(server, name, config, handler) {
    if (typeof name !== 'string' || name.length === 0 || name.includes('__')) {
      throw new Error(`centralu.tool: "${name}" is not a usable tool name ("__" separates names in sessions; use "_" or "-")`)
    }
    const hasInput = config?.inputSchema !== undefined
    const run = (...a) => {
      // with an input schema the SDK calls (args, ctx); without one it calls (ctx)
      const ctx = hasInput ? a[1] : a[0]
      const store = {
        runId: ctx?.mcpReq?._meta?.[RUN_META] ?? null,
        signal: ctx?.mcpReq?.signal,
        progressToken: ctx?.mcpReq?._meta?.progressToken,
        notify: ctx?.mcpReq?.notify,
      }
      return runs.run(store, async () => {
        try {
          return await handler(...a)
        } catch (e) {
          console.error(`[${APP_ID}] tool ${name} threw:`, e)
          throw e
        }
      })
    }
    // registerAppTool reads config._meta.ui and throws on a tool without _meta (S-6 agent run)
    return config?._meta ? registerAppTool(server, name, config, run) : server.registerTool(name, config, run)
  },

  /**
   * Serves `htmlUrl` (e.g. `new URL('./ui/index.html', import.meta.url)`) as the screen `uri`.
   * The file is read on every request, so edits to the screen show without a restart. Where the page
   * has `<script src="centralu:mcp-app.js"></script>`, the vendored MCP App bridge is inlined.
   */
  uiResource(server, name, uri, htmlUrl, config = {}) {
    const bridgeUrl = new URL('./mcp-app.js', import.meta.url)
    return registerAppResource(server, name, uri, { ...config, mimeType: RESOURCE_MIME_TYPE }, async () => {
      let html = await readFile(htmlUrl, 'utf8')
      if (html.includes(BRIDGE_TAG)) {
        const js = await readFile(bridgeUrl, 'utf8')
        html = html.replace(BRIDGE_TAG, () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`)
      }
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }] }
    })
  },

  /**
   * Asks the agent of the person using Centralu, in a new session under this app, and returns its
   * final answer. With `schema` (a JSON Schema whose top level is an object) the answer is JSON of
   * that shape, checked by Centralu; without it, text. `tool` picks an agent by name ("claude",
   * "codex") when the manifest lists it in "uses": { "agent": [...] }; without it, the person's
   * default agent. The manifest must declare "uses": { "agent": true } (or the list), and the person
   * is asked once before the app's first run on each tool. Only inside a tool handler. Throws a
   * CentraluError that says what Centralu answered.
   */
  async agent(prompt, { schema, tool } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new BrokerError('centralu.agent() needs a prompt')
    const r = await askBroker('centralu.agent()', 'run_agent', { prompt, ...(schema ? { schema } : {}), ...(tool ? { tool } : {}) })
    return r.structuredContent ?? textOf(r)
  },

  /**
   * Calls a tool of another app this app declared in `uses.apps`, and returns its structured content
   * or its text. Only the other app's tools open to agents (visibility `model`). A project app finds
   * the app in its own project first, then in the person's user folder; a user-folder app only in the
   * user folder. Only inside a tool handler.
   */
  async callApp(app, tool, args = {}) {
    const r = await askBroker(`centralu.callApp(${JSON.stringify(app)}, ${JSON.stringify(tool)})`, 'call_app', { app, tool, args })
    return r.structuredContent ?? textOf(r)
  },

  /**
   * Reads one piece of Centralu's own data, by name, as JSON. The names are a closed list:
   * "sessions.list" (this project's sessions, or all of them for a user-folder app: the names shown in
   * the sidebar and their states, never the conversations) and "git.status" (this project's branch and changed files; project apps
   * only). Declare each one in "uses": { "host": [...] }. Only inside a tool handler.
   */
  async host(name) {
    const r = await askBroker(`centralu.host(${JSON.stringify(name)})`, 'host_data', { name })
    return r.structuredContent ?? JSON.parse(textOf(r))
  },

  /** Reads `<data folder>/<file>` as JSON, or `fallback` if the file does not exist yet. */
  async readJson(file, fallback) {
    const path = join(ensureDataDir(), file)
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return fallback
      throw e
    }
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error(`centralu.readJson: ${path} is not valid JSON (${e.message})`)
    }
  },

  /** Writes `value` as JSON to `<data folder>/<file>` — whole or not at all (write, then rename). */
  async writeJson(file, value) {
    const path = join(ensureDataDir(), file)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
    await rename(tmp, path)
  },
}
