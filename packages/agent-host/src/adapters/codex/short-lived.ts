import { CLIENT_INFO } from '@cc/protocol'
import { CodexClient } from './client.js'

/**
 * A short-lived `codex app-server` for one lookup or one change outside any session (#428): a thread list, the model
 * list, usage, a fork, a delete. Kept separate from the session process — piling lookup traffic onto a thread that is
 * mid-conversation would slow that thread down, and if something fails, there would be no telling which side died.
 *
 * It is initialized, handed to `fn`, and closed however `fn` ends. **Its close never replaces `fn`'s outcome**: an
 * `await client.dispose()` left bare in a `finally` would turn a fork that succeeded into the close's error. Server
 * requests (an approval nobody here can give) are answered empty.
 *
 * **`fn`'s promise must be awaited inside it.** A bare return of a request still in flight would let the close run
 * right there and kill the server mid-request — the reason the codex model list once never succeeded.
 */
export async function withCodexClient<T>(opts: { cwd: string; command: string }, fn: (client: CodexClient) => Promise<T>): Promise<T> {
  const client = new CodexClient(
    { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
    { cwd: opts.cwd, command: opts.command },
  )
  try {
    await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
    client.notify('initialized')
    return await fn(client)
  } finally {
    await client.dispose().catch(() => {})
  }
}
