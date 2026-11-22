/** A token shaped as Cursor's (a JWT) carrying these claims; never a real one */
export function jwt(claims: unknown): string {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}
