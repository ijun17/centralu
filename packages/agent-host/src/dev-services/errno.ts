import { isObj } from '../json-value.js'

/** The `code` a failed system call carries (`ENOENT`, `EPERM`, ...), when it is text; a `catch` gets `unknown` */
export function errnoCode(e: unknown): string | undefined {
  return isObj(e) && typeof e.code === 'string' ? e.code : undefined
}
