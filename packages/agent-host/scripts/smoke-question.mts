/**
 * End-to-end smoke test: **does a choice reach the screen, and does the answer make it back to the
 * model?** (AskUserQuestion).
 *
 * Displaying it alone with no way to send an answer is only half the feature — that is exactly how
 * the approval card once went dead. So there are two things checked here: does question_request
 * arrive, and once an answer is sent, **does the model know that answer and act on it.**
 *
 * Run with: pnpm smoke:question
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHost, type Json } from './host-client.mjs'

const cwd = mkdtempSync(join(tmpdir(), 'cc-q-'))
writeFileSync(join(cwd, 'README.md'), '# Target\n')

const { host, ws, events, call: rpc, next } = await openHost()
const waitFor = (pred: (e: Json) => boolean, ms: number, from?: number) => next(pred, 'event', ms, from).then(() => true, () => false)

const project = await rpc('projects.add', { path: cwd })
// Has to be 'normal' for canUseTool to be attached (with auto there is nowhere to intercept it)
const s = await rpc('agents.createSession', { projectId: project.id, cwd, tool: 'claude', permissionPreset: 'normal' })

await rpc('agents.send', {
  sessionId: s.id,
  text: 'Ask me a question with the AskUserQuestion tool: "What should I eat for lunch?" The options are "Sushi" and "Ramen". Only call the tool.',
})

const got = await waitFor((e) => e.sessionId === s.id && e.type === 'question_request', 150000)
const req = events.find((e) => e.sessionId === s.id && e.type === 'question_request')
console.log(`\n  did the options make it to the screen ${got ? '✅' : '❌'}`)
if (!got || !req) { ws.close(); host.kill(); process.exit(1) }

const q = req.questions[0]
console.log(`  question: ${q.question}`)
console.log(`  options: ${q.options.map((o: Json) => `${o.label}(${o.description})`).join(' · ')}`)
// Truncation once killed this feature — checks that the description survives whole
const intact = q.options.every((o: Json) => typeof o.description === 'string' && !o.description.endsWith('…'))
console.log(`  option descriptions not truncated ${intact && q.options.length >= 2 ? '✅' : '❌'}`)

const mark = events.length
await rpc('agents.answerQuestion', {
  sessionId: s.id,
  requestId: req.requestId,
  answers: [{ question: q.question, answers: ['Ramen'] }],
})

await waitFor((e) => e.sessionId === s.id && e.type === 'turn_complete', 150000, mark)
const said = events.slice(mark).filter((e) => e.sessionId === s.id && e.type === 'message_delta').map((e) => e.text).join('')
console.log(`\n── What the model said after getting the answer ──\n${said.trim().slice(0, 300)}\n`)

const knew = said.includes('Ramen')
const cleared = events.some((e) => e.sessionId === s.id && e.type === 'question_resolved')
console.log(`  did the card clear ${cleared ? '✅' : '❌'}`)
console.log(`  does the model know the chosen answer ${knew ? '✅' : '❌'}`)

// Answering a question that has disappeared must not silently succeed
let toldUs = false
try {
  await rpc('agents.answerQuestion', { sessionId: s.id, requestId: 'q-does-not-exist', answers: [] })
} catch (e) {
  // '사라졌' matches the (still Korean, out of this branch's scope) error thrown by
  // agent-host/src/sessions/manager.ts when a question has disappeared — kept as-is because it is
  // the value being compared against.
  toldUs = String((e as Error).message).includes('사라졌')
}
console.log(`  does it tell us when we answer a question that has disappeared ${toldUs ? '✅' : '❌'}`)

ws.close()
host.kill()
const ok = got && intact && knew && cleared && toldUs
console.log(ok ? '\n✅ PASS — the options were rendered and the answer made it back to the model' : '\n❌ check failed')
process.exit(ok ? 0 : 1)
