import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../../packages/agent-host/src/dev-services/store.js'

/**
 * An app shaped like the project board, for `perf:memory --steps appview`: what a view that stays open costs the window
 * over an hour. Built from the app template (its runtime copied as it is), with a server that answers a board of
 * `CARDS` cards that change on every read, and a view that draws the whole board again on every answer (as the
 * board's `show` does with innerHTML), polls a queue tool every 15 s (the board's QUEUE_POLL_MS while its queue has
 * work) and reads the board again whenever Centralu says the app changed. Nothing in it reaches the network or writes.
 */

export const BOARD_APP_ID = 'perf-board'
/** About a busy board: open issues and pull requests across the Status columns */
const CARDS = 150

const runtime = fileURLToPath(new URL('../../packages/agent-host/app-template/runtime', import.meta.url))

/** Writes the app into the project's folder and trusts the project in the store, so the host runs it without a prompt */
export function seedBoardApp(dataDir: string, project: { id: string; path: string }): { appId: string; projectId: string } {
  const dir = join(project.path, '.centralu', 'apps', BOARD_APP_ID)
  mkdirSync(join(dir, 'ui'), { recursive: true })
  cpSync(runtime, join(dir, 'runtime'), { recursive: true })
  writeFileSync(
    join(dir, 'centralu.app.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: BOARD_APP_ID,
      name: 'Perf board',
      version: '0.1.0',
      description: 'A board of cards that change on every read, for the memory measurement.',
      server: { command: 'node', args: ['server.mjs'] },
      home: 'show',
      view: { span: { cols: 2, rows: 1 } },
    }),
  )
  writeFileSync(join(dir, 'server.mjs'), SERVER)
  writeFileSync(join(dir, 'ui', 'index.html'), VIEW)
  const store = new Store(join(dataDir, 'store.db'))
  try {
    store.projects.setProjectTrusted(project.id, true)
  } finally {
    store.close()
  }
  return { appId: BOARD_APP_ID, projectId: project.id }
}

const SERVER = `import { McpServer, serveStdio, z, centralu } from './runtime/centralu-app-runtime.mjs'

const UI = 'ui://${BOARD_APP_ID}/index.html'
const STATUSES = ['Needs decision', 'Ready', 'In progress', 'In review', 'Done']
let reads = 0
const board = () => {
  reads++
  const items = Array.from({ length: ${CARDS} }, (_, i) => ({
    number: 2000 + i,
    title: 'Item ' + (2000 + i) + ': what the window keeps while a view stays open, read ' + reads + ' times',
    status: STATUSES[(i + reads) % STATUSES.length],
    priority: ['High', 'Medium', 'Low'][i % 3],
    area: ['UI', 'Host', 'Apps', 'CI'][i % 4],
    updatedAt: new Date(Date.now() - i * 60_000).toISOString(),
    labels: ['tier:light', 'perf', i % 2 ? 'ui' : 'host'],
  }))
  return { content: [{ type: 'text', text: items.length + ' items' }], structuredContent: { ok: true, reads, items } }
}
const queue = () => ({
  content: [{ type: 'text', text: 'queue' }],
  structuredContent: { queue: Array.from({ length: 6 }, (_, i) => ({ pr: 2300 + i, state: ['ci', 'waiting', 'attention'][(i + reads) % 3], at: Date.now() })) },
})

serveStdio(() => {
  const server = new McpServer({ name: '${BOARD_APP_ID}', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } })
  centralu.uiResource(server, 'main-screen', UI, new URL('./ui/index.html', import.meta.url))
  centralu.tool(server, 'show', { title: 'Show the board', description: 'The board.', inputSchema: z.object({}), annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: UI } } }, async () => board())
  centralu.tool(server, 'queue', { title: 'The queue', description: 'The merge queue.', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => queue())
  return server
})
`

const VIEW = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; font: 13px system-ui, sans-serif; }
      #board { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; padding: 8px; }
      .card { border: 1px solid #514c48; border-radius: 4px; padding: 6px; margin-bottom: 6px; }
      .labels span { margin-right: 4px; }
    </style>
  </head>
  <body>
    <div id="queue"></div>
    <div id="board"></div>
    <script src="centralu:mcp-app.js"></script>
    <script>
      const app = new McpApp.App({ name: '${BOARD_APP_ID}', version: '0.1.0' })
      const $ = (id) => document.getElementById(id)
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';')
      function show(result) {
        const items = result?.structuredContent?.items
        if (!items) return
        const columns = new Map()
        for (const it of items) columns.set(it.status, [...(columns.get(it.status) ?? []), it])
        $('board').innerHTML = [...columns].map(([status, cards]) =>
          '<section><h3>' + esc(status) + ' (' + cards.length + ')</h3>' + cards.map((c) =>
            '<div class="card" data-card="' + c.number + '"><b>#' + c.number + '</b> ' + esc(c.title) +
            '<div class="labels">' + c.labels.map((l) => '<span>' + esc(l) + '</span>').join('') +
            '</div><small>' + esc(c.priority) + ' · ' + esc(c.area) + ' · ' + esc(c.updatedAt) + '</small></div>').join('') +
          '</section>').join('')
      }
      const reread = async () => show(await app.callServerTool({ name: 'show', arguments: {} }))
      async function loadQueue() {
        const r = await app.callServerTool({ name: 'queue', arguments: {} }).catch(() => null)
        const q = r?.structuredContent?.queue ?? []
        $('queue').innerHTML = q.map((i) => '<div>#' + i.pr + ' ' + esc(i.state) + '</div>').join('')
        setTimeout(loadQueue, 15_000)
      }
      app.ontoolresult = (params) => show(params)
      app.fallbackNotificationHandler = async (n) => {
        if (n.method === 'centralu/notifications/changed') await reread()
      }
      app.connect().then(() => Promise.all([reread(), loadQueue()]))
    </script>
  </body>
</html>
`
