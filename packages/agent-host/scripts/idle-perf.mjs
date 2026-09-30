/**
 * T6-2: first idle-performance measurement (against the docs/product-spec.md §7.1 target).
 * Measures only the host process, without a host + browser (UI measurement happens for real in G5).
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

const host = spawn('node', ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', 't', '--memory'], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((r) => host.stdout.on('data', (d) => String(d).includes('"ready"') && r()))
console.log('host pid', host.pid, '— 10초 유휴 관측')

const sample = async () => {
  const { stdout } = await exec('ps', ['-o', '%cpu=,rss=', '-p', String(host.pid)])
  const [cpu, rss] = stdout.trim().split(/\s+/).map(Number)
  return { cpu, rssMb: Math.round(rss / 1024) }
}
await sample()
const samples = []
for (let i = 0; i < 5; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  samples.push(await sample())
}
const avgCpu = samples.reduce((a, s) => a + s.cpu, 0) / samples.length
const maxRss = Math.max(...samples.map((s) => s.rssMb))
console.log('유휴 CPU 평균: ' + avgCpu.toFixed(2) + '% (목표 <1%)')
console.log('host RSS 최대: ' + maxRss + 'MB')
console.log(avgCpu < 1 ? '✅ 유휴 CPU 목표 충족' : '❌ 유휴 CPU 목표 미달')
host.kill()
