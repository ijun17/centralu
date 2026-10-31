/**
 * The shape of an entry's id and label in `serve.json` (#1405): exactly what the launcher lists and `--revoke` takes
 * (`serve-files.mjs` `parseServeState`, `serve-args.mjs` `CREDENTIAL_ID_RE` and `PAIR_LABEL_RE`), and what a hub's
 * machine row shows. A module of its own so the link keys (`transport/link-keys.ts`, the key id in the transcript) and
 * the credential file (`serve-credentials.ts`, which checks a key entry's public key with them) both read it without
 * importing each other.
 */
export const CREDENTIAL_ID_RE = /^[0-9a-f]{8}$/
export const CREDENTIAL_LABEL_RE = /^[A-Za-z0-9:._-]{1,80}$/
