#!/usr/bin/env node
/**
 * A stand-in keeper for scripts/shell-integration.mts. It is put into signed test content as
 * `centralu-keeper`, so the shell starts it exactly as it would start the real one. It records where
 * it runs from, its arguments and its process group in `<data>/fake-keepers.jsonl`, writes a line to
 * stdout and stderr (which the shell sends to keeper.log), and answers `status` and `stop` on
 * `<data>/keeper.sock` like a keeper. `<data>/fake-mode` containing `exit1` makes it exit at once.
 */
const fs = require('node:fs')
const net = require('node:net')
const { execFileSync } = require('node:child_process')

const args = process.argv.slice(2)
const data = args[args.indexOf('--data-dir') + 1]
let pgid = null
try {
  pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim())
} catch {}
const modeFile = `${data}/fake-mode`
const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'answer'
fs.appendFileSync(`${data}/fake-keepers.jsonl`, `${JSON.stringify({ pid: process.pid, pgid, script: process.argv[1], args, mode })}\n`)
console.log(`fake keeper stdout ${process.pid}`)
console.error(`fake keeper stderr ${process.pid}`)
if (mode === 'exit1') process.exit(1)

const sock = `${data}/keeper.sock`
try {
  fs.unlinkSync(sock)
} catch {}
const server = net.createServer((c) => {
  let buf = ''
  c.on('data', (d) => {
    buf += d
    const i = buf.indexOf('\n')
    if (i < 0) return
    const req = JSON.parse(buf.slice(0, i))
    if (req.op === 'stop') {
      c.end(`${JSON.stringify({ ok: true })}\n`)
      server.close()
      try {
        fs.unlinkSync(sock)
      } catch {}
      setTimeout(() => process.exit(0), 50)
      return
    }
    c.end(`${JSON.stringify({ ok: true, view: { keeper: { pid: process.pid } } })}\n`)
  })
  c.on('error', () => {})
})
server.listen(sock)
// Never outlives a run that forgot it.
setTimeout(() => process.exit(0), 120_000)
