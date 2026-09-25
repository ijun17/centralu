/**
 * The Centralu app runtime: everything an app made from the template imports, bundled into one
 * file so `node server.mjs` runs with no `npm install` (plan S-6).
 *
 *   MCP server SDK v2 (McpServer, serveStdio), zod, the MCP Apps server helpers, and `centralu`.
 */
import { serveStdio as sdkServeStdio } from '@modelcontextprotocol/server/stdio'

export { McpServer, inputRequired, acceptedContent } from '@modelcontextprotocol/server'
export { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
export { z } from 'zod'
export { centralu } from './centralu.mjs'

/*
 * stdout is the MCP channel. A stray console.log from app code would corrupt it and every request
 * would fail with nothing said anywhere, so console output goes to stderr, which Centralu keeps in
 * the app's log and shows when the app fails.
 */
for (const k of ['log', 'info', 'debug']) console[k] = console.error.bind(console)

const APP = process.env.CENTRALU_APP_ID ?? 'app'
const reported = new WeakSet()

/**
 * `serveStdio`, but a failure says why on stderr. Without this, a throw while registering tools
 * became a bare -32603 on every request and stderr stayed empty (S-6 agent run: 15 turns lost).
 */
export function serveStdio(factory, options = {}) {
  const guarded = (...a) => {
    try {
      return factory(...a)
    } catch (e) {
      console.error(`[${APP}] the server could not start — setting up the server threw (no tool can be called until this is fixed):`, e)
      if (e && typeof e === 'object') reported.add(e)
      throw e
    }
  }
  return sdkServeStdio(guarded, {
    ...options,
    onerror: (e) => {
      if (!reported.has(e)) console.error(`[${APP}] server error:`, e)
      options.onerror?.(e)
    },
  })
}
