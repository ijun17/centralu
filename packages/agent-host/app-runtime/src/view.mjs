/**
 * The screen side: the official MCP App bridge (ext-apps `App`) for an app's `ui/index.html`.
 * Bundled to a browser script that sets `window.McpApp`; `centralu.uiResource` inlines it where the
 * page has `<script src="centralu:mcp-app.js"></script>`.
 */
export { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps'
