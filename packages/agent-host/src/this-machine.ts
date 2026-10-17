import { isIP } from 'node:net'

/**
 * Whether a host names this machine or an address on its own network edge, which a link the person was handed (an
 * import) or a declaration an app made (a view's CSP) must never reach: `localhost` and `*.localhost`, loopback
 * (`127.0.0.0/8`, `::1`), the unspecified address (`0.0.0.0/8`, `::`), link-local (`169.254.0.0/16`, where cloud
 * metadata lives, and `fe80::/10`), and an IPv4-mapped IPv6 address (`::ffff:`, which is how the same IPv4 address is
 * written to get around a check of the IPv4 form).
 *
 * `host` is a WHATWG URL's `hostname` (`new URL(…).hostname`): numeric IPv4 spellings (`127.1`, an integer, octal,
 * hexadecimal) are already dotted by then, and an IPv6 address is bracketed. Brackets and case are dealt with here.
 * What a name resolves to is not checked (a documented limit, docs/security-boundaries.md).
 */
export function isThisMachineHost(host: string): boolean {
  // A trailing dot names the same host (`localhost.`), and a URL keeps it
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (isIP(h) === 4) return isThisMachineV4(h.split('.').map(Number) as [number, number, number, number])
  if (isIP(h) !== 6) return false
  if (h === '::1' || h === '::' || /^fe[89ab]/.test(h) || h.startsWith('::ffff:')) return true
  /*
   * An IPv4 address carried in an IPv6 one: `::127.0.0.1` (the old IPv4-compatible form, which a URL writes `::7f00:1`)
   * and the NAT64 prefix `64:ff9b::/96`. Both reach the IPv4 address in their last 32 bits, on a network that translates.
   */
  const groups = v6Groups(h)
  if (!groups) return false
  const tail = groups.slice(6)
  const head = groups.slice(0, 6)
  const compatible = head.every((g) => g === 0)
  const nat64 = head[0] === 0x64 && head[1] === 0xff9b && head.slice(2).every((g) => g === 0)
  if (!compatible && !nat64) return false
  const [hi, lo] = tail as [number, number]
  return isThisMachineV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff])
}

function isThisMachineV4([a, b]: readonly number[]): boolean {
  return a === 127 || a === 0 || (a === 169 && b === 254)
}

/** The eight 16-bit groups of an IPv6 address (`::` expanded, a dotted IPv4 tail turned into two groups), or null */
function v6Groups(h: string): number[] | null {
  let text = h
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const side = (part: string | undefined) => (part ? part.split(':').map((g) => parseInt(g, 16)) : [])
  const left = side(halves[0])
  const right = side(halves[1])
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0
  const groups = halves.length === 2 ? [...left, ...new Array<number>(Math.max(fill, 0)).fill(0), ...right] : left
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}
