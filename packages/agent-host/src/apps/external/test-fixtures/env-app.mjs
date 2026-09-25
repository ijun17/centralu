/**
 * 건네기(M4 E) 시험의 앱 — 진짜 자식 프로세스로 뜨는 진짜 MCP 서버다(app.mjs와 같은 SDK, 같은 모양).
 * app.mjs와 따로 두는 이유: 그 파일은 중개(D) 쪽이 함께 고치는 자리라, 비밀·가져오기·버전 시험이 거기에 기대면
 * 두 갈래의 수정이 한 파일에서 부딪힌다.
 *
 *   node env-app.mjs [--env <이름>] [--require-env] [--leak]
 *
 * --env          이 이름의 환경 변수를 `env` 도구가 돌려준다 — 앱이 **실제로 받은** 값을 시험이 본다(host의 말이 아니라)
 * --require-env  그 변수가 없으면 뜨자마자 표준에러에 한 줄 쓰고 끝난다 (키가 없어 못 뜨는 앱)
 * --leak         받은 값을 흘리는 앱: 뜰 때 표준에러에 쓰고, `leak_fail`은 실패 문구에 싣는다
 *
 * `version` 도구는 앱 폴더(cwd)의 version.txt를 **뜰 때 한 번** 읽은 값을 돌려준다 — 되돌리기 시험이 "어느 코드로
 * 떴나"를 본다(서버 코드는 이 파일 하나라, 판이 바뀌는 것은 폴더의 내용이다).
 */
import { existsSync, readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name) => process.argv.includes(`--${name}`)
const NAME = arg('env') ?? 'API_KEY'
const value = process.env[NAME]
const VERSION = existsSync('version.txt') ? readFileSync('version.txt', 'utf8').trim() : '(no version.txt)'

if (flag('require-env') && !value) {
  process.stderr.write(`env-app: ${NAME} is not set — cannot start\n`)
  process.exit(4)
}
if (flag('leak')) process.stderr.write(`env-app: starting with ${NAME}=${value ?? '(none)'}\n`)

const say = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

serveStdio(() => {
  const server = new McpServer({ name: 'env-app', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('env', { description: 'What this process received', annotations: { readOnlyHint: true } }, async () =>
    say(`${NAME}=${value ?? '(none)'} pid=${process.pid}`),
  )
  server.registerTool('version', { description: 'The version.txt this process started with', annotations: { readOnlyHint: true } }, async () =>
    say(VERSION),
  )
  server.registerTool('echo', { description: 'Echo', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => say(`echo: ${text}`))
  server.registerTool('leak_fail', { description: 'Fails, with what it received in the message' }, async () => {
    process.stderr.write(`env-app: about to fail holding ${value ?? '(none)'}\n`)
    return say(`could not use ${NAME}=${value ?? '(none)'}`, true)
  })
  return server
})
