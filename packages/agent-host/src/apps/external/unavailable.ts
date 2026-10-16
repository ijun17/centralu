/** An app that cannot be called — the reason is exactly the message */
export class AppUnavailableError extends Error {
  readonly code = 'internal'
}
