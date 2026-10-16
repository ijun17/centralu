// The screen: its resource (with the CSP Centralu reads) and `show`, the home tool.
import { centralu, z } from './runtime/centralu-app-runtime.mjs'
import { board, columns, refreshInput, where } from './board.mjs'
import { config } from './config.mjs'
import { forView } from './handlers.mjs'
import { answer } from './reply.mjs'

export const UI = 'ui://project-board/index.html'

/**
 * What the view may load from outside: images on GitHub's own hosts, nothing else (no network, no
 * frames). `github.com/user-attachments/…` (an image pasted into an issue) redirects to
 * `private-user-images.githubusercontent.com`, and avatars and older uploads live on other
 * `githubusercontent.com` hosts. markdown.mjs writes an <img> only for these hosts; any other image
 * stays a link. Centralu reads this from the resource's contents (docs/apps.md §6.4).
 */
export const VIEW_CSP = { resourceDomains: ['https://github.com', 'https://*.githubusercontent.com'] }

/**
 * The runtime's `uiResource`, with `_meta` on the resource and on its contents: Centralu reads a
 * view's CSP from the contents (the standard's place, docs/apps.md §6.4), and the runtime's helper
 * puts nothing there.
 */
export function viewResource(server, name, uri, file, meta) {
  const withMeta = {
    registerResource: (n, u, cfg, read) =>
      server.registerResource(n, u, { ...cfg, _meta: meta }, async (...a) => {
        const r = await read(...a)
        return { ...r, contents: r.contents.map((c) => ({ ...c, _meta: { ...c._meta, ...meta } })) }
      }),
  }
  return centralu.uiResource(withMeta, name, uri, file)
}

export const tools = {
  // The home tool: the screen's whole state, read from GitHub. It answers a failure as data rather
  // than isError, so the screen states the reason (GitHub unreachable, gh missing, scope missing)
  // instead of showing an empty board, and an outage is not filed as a bug in the app.
  show: {
    config: {
      title: 'Show the board',
      description: 'Open the board and return the project, its Status/Priority/Area options and its items.',
      inputSchema: z.object({ refresh: refreshInput }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: UI, visibility: ['app'] } },
    },
    handler: forView(async ({ refresh }) => {
      const b = await board({ fresh: refresh === true })
      return answer(`${b.items.length} items. ${where(b)}.`, {
        ok: true,
        project: b.project,
        repository: config.repository,
        columns: columns(b),
        decisionStatus: config.decisionStatus,
        options: { status: b.fields.status.options.map((o) => o.name), priority: b.fields.priority.options.map((o) => o.name), area: b.fields.area.options.map((o) => o.name) },
        items: b.items,
        fetchedAt: b.fetchedAt,
      })
    }),
  },
}
