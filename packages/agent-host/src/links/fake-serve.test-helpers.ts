/**
 * A fake `centralu.mjs` for update tests: plays its version's `serve`. `--stop` and `--detach` write what
 * happened to `<data>/events` and which version runs to `<data>/running`; `FAKE_BROKEN=<version>` makes that
 * version fail to start and leave a line in `host.log`. `--autostart off` removes `<data>/autostart`, the
 * stand-in for a boot entry; `FAKE_AUTOSTART_FAILS` makes it refuse, `FAKE_NO_AUTOSTART` plays a version that
 * predates it. `FAKE_STOP_FAILS` makes `--stop` refuse.
 */
export const fakeServe = (version: string) => `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
const d = process.env.CC_DATA_DIR || process.env.HOME + '/.centralu'
const a = process.argv.slice(2).join(' ')
const log = (s) => appendFileSync(d + '/events', s + '\\n')
if (a === 'serve --stop') {
  const was = existsSync(d + '/running')
  log('stop ' + (was ? readFileSync(d + '/running', 'utf8') : '-'))
  rmSync(d + '/running', { force: true })
  console.log(JSON.stringify({ v: 1, stop: process.env.FAKE_STOP_FAILS ? { ok: false, wasRunning: true, message: 'the host on 127.0.0.1:4141 is still running' } : { ok: true, wasRunning: was } }))
} else if (a === 'serve --detach') {
  log('start ${version}')
  if (process.env.FAKE_BROKEN === '${version}') {
    appendFileSync(d + '/host.log', 'host ${version}: the store was written by a newer Centralu\\n')
    console.log(JSON.stringify({ v: 1, detach: { ok: false, reason: 'exited', message: 'the host exited before it answered' } }))
  } else {
    writeFileSync(d + '/running', '${version}')
    console.log(JSON.stringify({ v: 1, port: 4141, token: 't', version: '${version}', protocolVersion: 1, dataDir: d, hostRunning: true, detach: { ok: true, how: 'setsid' } }))
  }
} else if (a === 'serve --autostart off') {
  log('autostart off')
  if (process.env.FAKE_NO_AUTOSTART) {
    console.error('unknown option for serve: --autostart')
    process.exitCode = 2
  } else if (process.env.FAKE_AUTOSTART_FAILS) {
    console.log(JSON.stringify({ v: 1, autostart: { ok: false, on: true, how: 'systemd', linger: null, message: 'Failed to connect to bus' } }))
  } else {
    rmSync(d + '/autostart', { force: true })
    console.log(JSON.stringify({ v: 1, autostart: { ok: true, on: false, how: 'systemd', linger: null } }))
  }
} else console.log('unexpected ' + a)
`
