/**
 * Whether an ssh failure says the machine does not answer at all (#1398): it is asleep, off, or off the network. That is a
 * state of the machine, not an error of the link, so the row says `away` with when it was last seen and when the hub tries
 * again, and ssh's own line stays in the details.
 *
 * Only what ssh says when it never got an answer from the other end:
 *
 *   - the connect timed out (`Operation timed out`, `Connection timed out`, ssh's `ConnectTimeout`)
 *   - there is no route (`No route to host`, `Network is unreachable`, `Host is down`)
 *   - the name does not resolve (`Could not resolve hostname`, `Name or service not known`, `nodename nor servname`,
 *     `Temporary failure in name resolution`, Windows' `No such host is known`)
 *
 * Everything else stays an error with its reason: a refused connection (the machine is up and nothing listens), a key it
 * refused, a changed host key, a connection closed or timed out during the banner (something answered), and any failure of the
 * host there. The words are ssh's own (OpenSSH on macOS, Linux and Windows), matched on the whole last line.
 */
/** What the tunnel puts in front of the last line of ssh's stderr when ssh itself failed (exit 255), `tunnel.ts` */
const SSH_FAILED = /^ssh could not reach .*?: /
/** Why a connect did not get through, in ssh's words (macOS, Linux and Windows) */
const CONNECT_FAILED = 'Operation timed out|Connection timed out|No route to host|Network is unreachable|Host is down'
/**
 * The whole last line, nothing before or after: a line a remote program printed that happens to say "timed out" (curl's, WSL's)
 * is not ssh failing to connect. Through a jump host (ProxyJump) the connect is the jump host's, and ssh says it as the `channel`
 * line, or says that the connection to the unknown peer timed out; a connection that timed out talking to a real host
 * (the banner exchange) is a machine that answered, so it stays an error.
 */
const NO_ANSWER = new RegExp(
  [
    `^(?:ssh: )?connect to host \\S+ port \\d+: (?:${CONNECT_FAILED})\\.?$`,
    '^(?:ssh: )?Could not resolve hostname \\S+: .+$',
    `^channel \\d+: open failed: connect failed: (?:${CONNECT_FAILED})\\.?$`,
    '^Connection to UNKNOWN port 65535 timed out$',
  ].join('|'),
  'i',
)

/** What ssh said last (`lastLine` of its stderr, after the tunnel's `ssh could not reach <target>: `) says the machine does not answer */
export function isNoAnswer(message: string): boolean {
  const failed = SSH_FAILED.exec(message)
  return failed !== null && NO_ANSWER.test(message.slice(failed[0].length).trim())
}
