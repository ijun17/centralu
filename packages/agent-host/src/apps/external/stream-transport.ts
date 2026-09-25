import type { Readable, Writable } from 'node:stream'
import { ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client'

/**
 * 스트림 한 쌍 위의 MCP 전송 — stdio 바인딩과 같은 줄 단위 JSON (M4 A-3, 스파이크 S-4·S-5).
 *
 * SDK의 `StdioClientTransport`를 쓰지 않는 이유 둘 (스파이크에서 잰 것):
 *   1. 그 전송은 **자기가 자식을 띄운다.** 우리는 자식에게 표준 입출력 말고 파이프 하나(fd 3,
 *      중개)를 더 줘야 해서, 띄우는 일을 우리가 해야 한다.
 *   2. 규격 세대를 알아내려고 **앱을 두 번 띄운다**(탐색용 형제 프로세스 + 진짜). S-4에서
 *      2025 세대 서버가 연결 한 번에 프로세스 2개를 띄웠다. 이 전송은 같은 연결 위에서
 *      묻는다 — SDK는 `_dispose`가 없는 stdio 모양 전송을 "제자리 탐색"으로 다룬다.
 *
 * `pid`와 `stderr`는 **읽히지 않아도 있어야 한다.** v2 클라이언트는 이 두 속성이 있는지로
 * stdio 모양인지 가린다(`detectProbeTransportKind`). 없으면 HTTP로 여겨서, 탐색에 답하지
 * 않는 2025 세대 서버를 "옛 서버니 initialize로 내려가자"가 아니라 "장애"로 끊는다
 * (S-5 probe-classify: SDK 전송 재사용 시 `REQUEST_TIMEOUT`, 이 전송은 legacy로 연결).
 */
export class StreamTransport implements Transport {
  readonly pid: number | null
  readonly stderr = null
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private buf = new ReadBuffer()
  private closed = false

  constructor(
    private readable: Readable,
    private writable: Writable,
    opts: { pid?: number | null } = {},
  ) {
    this.pid = opts.pid ?? null
  }

  async start(): Promise<void> {
    this.readable.on('data', (chunk: Buffer) => {
      this.buf.append(chunk)
      for (;;) {
        let msg: JSONRPCMessage | null
        try {
          msg = this.buf.readMessage()
        } catch (e) {
          // 한 줄이 깨졌다고 연결을 버리지 않는다 — 앱이 표준출력에 로그를 섞은 경우다
          this.onerror?.(e as Error)
          continue
        }
        if (msg === null) break
        this.onmessage?.(msg)
      }
    })
    this.readable.on('error', (e) => this.onerror?.(e))
    this.readable.on('end', () => void this.close())
    this.readable.on('close', () => void this.close())
    // 앱이 먼저 죽으면 쓰기 쪽이 EPIPE를 낸다 — 처리하지 않으면 host의 미처리 예외가 된다
    this.writable.on('error', (e) => this.onerror?.(e))
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('app connection closed'))
    return new Promise((resolve, reject) => {
      this.writable.write(serializeMessage(message), (err) => (err ? reject(err) : resolve()))
    })
  }

  /** 우리 쪽 상태만 닫는다. 파이프를 닫는 것은 종료 규칙(AppProcess.stop)의 일이다 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}
