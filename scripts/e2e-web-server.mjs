#!/usr/bin/env node
/**
 * Runs one of the e2e suite's dev servers and starts it again if it dies mid-run (#651).
 *
 *   node scripts/e2e-web-server.mjs --url http://127.0.0.1:5174 -- pnpm --filter @cc/web exec vite --port 5174
 *
 * Playwright starts each `webServer` once and never again. When vite aborted under Node 26.9 (a V8
 * "Lazy deopt after a fast API call" abort inside Node's HTTP response path, nothing the app does),
 * every test after it failed with `ERR_CONNECTION_RESET` at its 20 s limit: 274 failures and a
 * quarter of an hour for one crash. This keeps the server's own output as it is, says in one line
 * that it died and how, and starts it again, so a crash costs the tests that were talking to it.
 *
 * It does not hide a server that cannot run. One that ends before it has ever answered `--url` (a
 * taken port, a broken config) ends this with its exit code, as it would have ended Playwright's
 * start. One that dies more than `--restarts` times (default 3) ends this too, saying so.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const USAGE = 'usage: node scripts/e2e-web-server.mjs --url <url> [--restarts <n>] -- <command...>'

function parse(argv) {
  const at = argv.indexOf('--')
  if (at < 0 || at === argv.length - 1) throw new Error(USAGE)
  const opts = argv.slice(0, at)
  const command = argv.slice(at + 1).join(' ')
  let url
  let restarts = 3
  for (let i = 0; i < opts.length; i += 2) {
    if (opts[i] === '--url') url = opts[i + 1]
    else if (opts[i] === '--restarts') restarts = Number(opts[i + 1])
    else throw new Error(`${USAGE}\nunknown option ${opts[i]}`)
  }
  if (!url || !Number.isInteger(restarts) || restarts < 0) throw new Error(USAGE)
  return { url, restarts, command }
}

const say = (line) => process.stderr.write(`[e2e-web-server] ${line}\n`)

/** A death, for e2e/web-server-report.ts to tell after the run (the line above is lost in a long log) */
function record(url, how, restarted) {
  const file = process.env.E2E_WEB_SERVER_EVENTS
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ url, how, restarted })}\n`)
  } catch (e) {
    say(`could not record the death in ${file}: ${e.message}`)
  }
}

/** Whether the server answers at all (any status: vite's index may 404 under some configs) */
async function answers(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return true
  } catch {
    return false
  }
}

function main() {
  let opts
  try {
    opts = parse(process.argv.slice(2))
  } catch (e) {
    say(e.message)
    process.exit(2)
  }
  const { url, restarts, command } = opts
  let child
  let stopping = false
  let deaths = 0

  const start = () => {
    let ready = false
    // A shell, as Playwright runs a `webServer` command, so `pnpm` resolves the same way on every OS
    child = spawn(command, { shell: true, stdio: 'inherit' })
    const poll = setInterval(async () => {
      if (ready) return
      if (await answers(url)) {
        ready = true
        clearInterval(poll)
      }
    }, 250)
    child.on('exit', (code, signal) => {
      clearInterval(poll)
      if (stopping) return process.exit(code ?? 1)
      const how = signal ? `signal ${signal}` : `exit code ${code}`
      if (!ready) {
        say(`${command} ended (${how}) before it answered ${url}; not starting it again`)
        return process.exit(code || 1)
      }
      deaths += 1
      record(url, how, deaths <= restarts)
      if (deaths > restarts) {
        say(`${command} died again (${how}), ${deaths} times in this run; giving up, so every later test against ${url} fails`)
        return process.exit(code || 1)
      }
      say(`${command} died mid-run (${how}); its last output is above. Starting it again (${deaths} of ${restarts}) so the tests after this one can reach ${url}`)
      start()
    })
  }

  const stop = (signal) => {
    stopping = true
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal)
    else process.exit(0)
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  start()
}

main()
