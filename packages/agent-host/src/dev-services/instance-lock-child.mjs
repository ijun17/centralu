import { acquireInstanceLock } from './instance-lock.ts'

const dbPath = process.argv[2]
const mode = process.argv[3]
const lock = acquireInstanceLock(dbPath)
if (!lock.ok) {
  console.log('blocked')
  process.exit(0)
}
console.log('acquired')
if (mode === 'hold') {
  process.kill(process.pid, 'SIGKILL')
}
if (mode === 'wait') {
  setTimeout(() => {
    lock.release()
  }, 500)
} else {
  lock.release()
}
