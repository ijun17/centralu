import { APP_ID_MAX_LENGTH, APP_SERVER_PREFIX, RESERVED_NAME_PREFIX, type NewAppIdProblem } from '@cc/protocol'

/**
 * The id for the "New app" dialog (M4 C-1) — derived from the name the person typed, and checked
 * against the same validation the host uses (`newAppIdProblem`).
 *
 * The id is both a folder name and becomes `app-<id>` in a session, so the name the person typed
 * cannot be used as-is. But asking for the id up front would make the person learn the rules first.
 * So it is derived from the name, shown, and left editable. The derivation rule narrows it down to
 * a shape the validation will pass: lowercase, any character outside letters and digits collapsed to
 * a single hyphen, no leading or trailing hyphens, up to 32 characters. A name that cannot be
 * converted to letters and digits, like Korean, ends up as an empty id — "please type one yourself"
 * is more honest than a fabricated id.
 */
export function deriveAppId(name: string): string {
  const slug = name
    // Strips accents and keeps the letter — "Café" becomes "cafe"
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // If truncation leaves a trailing hyphen, that is stripped too — the rule does not forbid a trailing hyphen, but "notes-" looks awkward as a derived id
  return slug.slice(0, APP_ID_MAX_LENGTH).replace(/-+$/, '')
}

/**
 * States to the person in front of the dialog why the validation rejected it — the host's own
 * wording (the rejection an agent reads from `create_app`) and this validation are the same check,
 * worded differently. An empty id is stated separately: it did not break a rule, it simply has not
 * been typed yet.
 */
export function appIdHint(id: string, problem: NewAppIdProblem): string {
  if (id === '') return 'Give the app an id: lowercase letters, digits and hyphens.'
  switch (problem) {
    case 'shape':
      return `Use lowercase letters, digits and hyphens (up to ${APP_ID_MAX_LENGTH}), starting with a letter or digit.`
    case 'reserved':
      return `Ids starting with "${RESERVED_NAME_PREFIX}" belong to Centralu itself.`
    case 'server-prefix':
      return `Ids starting with "${APP_SERVER_PREFIX}" are how apps attach to sessions. Pick another.`
    case 'builtin':
      return `"${id}" is a built-in app.`
  }
}
