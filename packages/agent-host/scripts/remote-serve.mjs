#!/usr/bin/env node
import { spawn } from 'node:child_process'

const rawArgs = process.argv.slice(2)
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: pnpm remote:serve -- [host options]\nBuilds the web UI with empty VITE host/token variables, then starts node --import tsx packages/agent-host/src/main.ts --web-root apps/web/dist.')
  process.exit(0)
}

const signals = ['SIGINT', 'SIGTERM']
let activeChild = null
let interruptedSignal = null

const signalHandlers = new Map(signals.map((signal) => [signal, () => forwardSignal(signal)]))
for (const [signal, handler] of signalHandlers) process.on(signal, handler)

try {
  const buildCode = await runChild('pnpm', ['build'], {
    ...process.env,
    VITE_HOST_TOKEN: '',
    VITE_HOST_URL: '',
  })
  if (interruptedSignal) process.exit(signalExitCode(interruptedSignal))
  if (buildCode !== 0) process.exit(buildCode)

  const hostCode = await runChild(process.execPath, [
    '--import',
    'tsx',
    'packages/agent-host/src/main.ts',
    '--web-root',
    'apps/web/dist',
    ...args,
  ], process.env)
  process.exit(interruptedSignal ? signalExitCode(interruptedSignal) : hostCode)
} finally {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler)
}

function runChild(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env })
    activeChild = child
    child.on('error', (error) => {
      console.error(error.code === 'ENOENT' ? `${command} was not found` : error.message)
      if (activeChild === child) activeChild = null
      resolve(error.code === 'ENOENT' ? 127 : 1)
    })
    child.on('close', (code, signal) => {
      if (activeChild === child) activeChild = null
      resolve(code ?? signalExitCode(signal))
    })
  })
}

function forwardSignal(signal) {
  interruptedSignal = signal
  if (activeChild) {
    activeChild.kill(signal)
    return
  }
  process.exit(signalExitCode(signal))
}

function signalExitCode(signal) {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return 1
}
