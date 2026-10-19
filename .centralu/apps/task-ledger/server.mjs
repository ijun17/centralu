// Task ledger — this app's MCP server. Centralu starts it (`node server.mjs`, stdio) when it is first needed and
// restarts it after the builder's turn when this folder changed. Read AGENTS.md first; docs/plans/task-ledger.md says
// what the app is for and why it is shaped so.
//
// The tasks live in the data folder (ledger.json), never in this folder. The app keeps running while there is any task
// that is not done (`centralu.busy`), hears of the project's sessions as they change, and tells the one responsible
// session when something needs it, once per change.
import { basename, resolve } from 'node:path'
import { McpServer, serveStdio, centralu } from './runtime/centralu-app-runtime.mjs'
import { Ledger } from './engine.mjs'
import { ghRunner, readFacts } from './github.mjs'
import { UI, makeTools } from './tools.mjs'
import { startSweeping, startWatching } from './watch.mjs'

// The app lives in <project>/.centralu/apps/task-ledger: the project's name is its folder's
const project = basename(resolve(process.cwd(), '..', '..', '..')) || null
const run = ghRunner({ cwd: process.cwd() })

const ledger = new Ledger({
  load: () => centralu.readJson('ledger.json', null),
  save: (data) => centralu.writeJson('ledger.json', data),
  notify: (address, text) => centralu.notify(address, text),
  readFacts: (args) => readFacts({ run, ...args }),
  busy: (reason) => void centralu.busy(reason),
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
  project,
})
await ledger.start()

const sweepMs = () => ledger.ledger.settings.sweepMinutes * 60_000
startWatching({ ledger, watchSessions: (o) => centralu.watchSessions(o), sweepMs })
startSweeping({ ledger, sweepMs })

const TOOLS = makeTools(ledger, { caller: () => centralu.noticeAddress() })
const ORDER = ['show', 'ledger_list', 'ledger_add', 'ledger_update', 'ledger_take_charge', 'ledger_settings', 'ledger_adopt', 'ledger_sweep']
const unlisted = Object.keys(TOOLS).filter((name) => !ORDER.includes(name))
if (unlisted.length) throw new Error(`server.mjs: add ${unlisted.join(', ')} to ORDER`)

serveStdio(() => {
  const server = new McpServer({ name: 'task-ledger', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } })
  centralu.uiResource(server, 'ledger', UI, new URL('./ui/index.html', import.meta.url))
  for (const name of ORDER) centralu.tool(server, name, TOOLS[name].config, TOOLS[name].handler)
  return server
})
