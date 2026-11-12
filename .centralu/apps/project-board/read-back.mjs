import { FATAL, GitHubError } from './github.mjs'

/**
 * What GitHub shows after a write whose answer may have been lost (gh failing on the connection with "EOF" says
 * nothing about whether GitHub carried it out): the answer of `read` (a pull request, a branch's head). Null when it
 * cannot be read now: a failure that would repeat for every call (rate limit, no network, no login) still throws.
 */
export async function readBack(read) {
  try {
    return await read()
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    return null
  }
}
