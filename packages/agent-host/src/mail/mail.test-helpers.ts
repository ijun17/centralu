import type { MailService, OpenInput, OpenResult } from './service.js'

/** `open` for a test that writes the caller beside the rest: `{ by: S1, kind: 'assign', ... }` */
export function openBy(mail: MailService, input: OpenInput & { by: string }): OpenResult {
  const { by, ...rest } = input
  return mail.open(by, rest)
}
