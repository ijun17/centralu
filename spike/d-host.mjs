// 검증 D: 미니 Agent Host — HTTP(정적 페이지) + WS(이벤트 릴레이), 브라우저에서 E2E
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { query } from '@anthropic-ai/claude-agent-sdk'

const PORT = 5177
const TOKEN = 'spike-token'
const html = readFileSync(new URL('./d-page.html', import.meta.url))

const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(html)
})
const wss = new WebSocketServer({ server: http })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
  if (url.searchParams.get('token') !== TOKEN) { ws.close(4001, 'bad token'); return }
  console.log('[host] 브라우저 연결됨')
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1 }))

  ws.on('message', async raw => {
    const msg = JSON.parse(raw)
    if (msg.type !== 'send') return
    console.log('[host] 프롬프트 수신:', msg.text)
    async function* once(text) {
      yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
    }
    try {
      const q = query({
        prompt: once(msg.text),
        options: { model: 'haiku', maxTurns: 1, permissionMode: 'default', includePartialMessages: true },
      })
      for await (const m of q) {
        if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
          ws.send(JSON.stringify({ type: 'message_delta', text: m.event.delta.text }))
        }
        if (m.type === 'result') {
          ws.send(JSON.stringify({ type: 'turn_complete', cost: m.total_cost_usd, tokens: m.usage?.output_tokens }))
        }
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }))
    }
  })
})

http.listen(PORT, '127.0.0.1', () => console.log(`[host] http+ws on http://127.0.0.1:${PORT}`))
