/**
 * Whether an ssh failure says the machine does not answer at all (#1398): asleep, off or off the network. That is the machine's
 * state, not a link error, so the row says `away` and the details keep ssh's line. Only what ssh says when it got no answer
 * from the other end counts (connect timeout, no route, a name that does not resolve); a refused connection, a refused or
 * changed key, a banner timeout and any failure of the host there stay errors.
 */
/** What the tunnel puts in front of the last line of ssh's stderr when ssh itself failed (exit 255), `tunnel.ts` */
const SSH_FAILED = /^ssh could not reach .*?: /
/** Why a connect did not get through, in ssh's words (macOS, Linux and Windows) */
const CONNECT_FAILED = 'Operation timed out|Connection timed out|No route to host|Network is unreachable|Host is down'
/**
 * The whole last line (OpenSSH on macOS, Linux and Windows): a remote program's own "timed out" (curl's, WSL's) is not ssh
 * failing to connect. Through a jump host (ProxyJump) the connect is the jump host's and ssh says it as the `channel` line or
 * as a timeout to the unknown peer; a timeout in the banner exchange means a machine answered.
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
