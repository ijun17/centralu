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
 * refused, a changed host key, a connection closed during the banner (something answered), and any failure of the host there.
 * The words are ssh's own (OpenSSH on macOS, Linux and Windows).
 */
const NO_ANSWER =
  /Operation timed out|Connection timed out|connect(?:ion)? to .* timed out|No route to host|Network is unreachable|Host is down|Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution|No such host is known/i

/** What ssh said last (`lastLine` of its stderr) says the machine does not answer */
export function isNoAnswer(message: string): boolean {
  return NO_ANSWER.test(message)
}
