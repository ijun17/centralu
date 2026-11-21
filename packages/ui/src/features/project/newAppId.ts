import { APP_ID_MAX_LENGTH, APP_SERVER_PREFIX, RESERVED_NAME_PREFIX, type NewAppIdProblem } from '@cc/protocol/client'

/**
 * The id for the "New app" dialog (M4 C-1), checked as the host checks it (`newAppIdProblem`). It is a folder name
 * and `app-<id>` in a session, so it is derived from the name, shown and editable, not asked up front. A name with no
 * Latin letters or digits (Korean) derives an empty id: asking beats a made-up one.
 */
export function deriveAppId(name: string): string {
  const slug = name
    // Strip accents: "Café" becomes "cafe"
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // The rule allows a trailing hyphen after truncation, but "notes-" looks awkward
  return slug.slice(0, APP_ID_MAX_LENGTH).replace(/-+$/, '')
}

/**
 * Why the id is refused, worded for the person; the same check an agent reads from `create_app` in the host's words.
 * Empty is said apart: it breaks no rule, it is not typed yet.
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
      return `"${id}" is reserved. Pick another.`
  }
}
