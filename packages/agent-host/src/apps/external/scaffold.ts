import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { oneLineText } from '@cc/protocol'
import { walkAppFolder } from './folder-walk.js'
import { MANIFEST_FILE, parseManifest, type AppManifest } from './manifest.js'

/**
 * The scaffold for a new app (M4 C-1) — expands the template folder into an app folder.
 *
 * The template (`packages/agent-host/app-template/`) is a product asset: it is the first code a
 * building agent ever sees, and it has to be an app that **follows the rules from the start** (tool
 * annotations, audience, state kept in the server, the data folder, change notifications) for the
 * agent to keep following that shape when it edits (S-6: the agent left the runtime alone and only
 * edited the server and the screen). The runtime (`runtime/`) is a build artifact, so it is copied
 * byte for byte (`build-app-runtime.mjs`).
 *
 * This file **only expands the template** — where it gets expanded (trust, the name, whether the id
 * already exists) is decided by the runtime's door (`createApp`).
 */

/** Placeholders where the app name and id are substituted in */
const ID = '{{APP_ID}}'
const NAME = '{{APP_NAME}}'
const DESCRIPTION = '{{APP_DESCRIPTION}}'

/** A build artifact — copied byte for byte, with no placeholder substitution */
const VERBATIM_DIR = 'runtime'

/**
 * A file that starts with a dot is kept in the template **without the dot**. The packaged build
 * collects resources through a glob (`resources/host/**`), and whether dotfiles are picked up
 * varies by bundling tool — if one is dropped, the build-artifact marker silently disappears from
 * every app.
 */
const RENAMED: Record<string, string> = { gitattributes: '.gitattributes' }

/** These files must exist for this to count as a template — a template missing the runtime produces an app where `node server.mjs` never starts */
const REQUIRED = [MANIFEST_FILE, 'server.mjs', join(VERBATIM_DIR, 'centralu-app-runtime.mjs'), join(VERBATIM_DIR, 'mcp-app.js')]

/**
 * Where the template lives. The same problem as the schema and bridge scripts (`bridge-path.ts`):
 * running from source finds it inside the package, and a bundled build finds it next to the build
 * output (`scripts/bundle.mjs` copies it there).
 */
export function appTemplateDir(): string {
  // The bundled layout is checked first — a packaged app trusts only the template next to it (whatever exists three levels up)
  const candidates = [
    new URL('./app-template/', import.meta.url), // the bundled build layout (next to resources/host/main.mjs)
    new URL('../../../app-template/', import.meta.url), // the source tree (src/apps/external → packages/agent-host)
  ].map((u) => fileURLToPath(u))
  const found = candidates.find((d) => REQUIRED.every((f) => existsSync(join(d, f))))
  if (!found) throw new Error(`app template not found (or its runtime is missing): ${candidates.join(', ')}`)
  return found
}

export type ScaffoldSpec = { id: string; name: string; description: string }

/**
 * Expands the template into `dest` (a folder that does not exist yet) and returns the manifest.
 *
 * The manifest is not produced by text substitution — it is **read, edited, and validated** before
 * being written (`parseManifest` — the same validation discovery reads with). A quote in the name
 * cannot break the JSON, and an app that fails validation stops before its folder is even created.
 */
export function scaffoldApp(templateDir: string, dest: string, spec: ScaffoldSpec): AppManifest {
  const raw = JSON.parse(readFileSync(join(templateDir, MANIFEST_FILE), 'utf8')) as Record<string, unknown>
  const text = JSON.stringify({ ...raw, id: spec.id, name: spec.name, description: spec.description }, null, 2) + '\n'
  const parsed = parseManifest(text)
  if (!parsed.ok) throw new Error(`the template's manifest does not pass with these values: ${parsed.error}`)

  mkdirSync(dest)
  copyTree(templateDir, dest, spec)
  writeFileSync(join(dest, MANIFEST_FILE), text)
  return parsed.manifest
}

function copyTree(from: string, to: string, spec: ScaffoldSpec): void {
  // The same walk as every other reader of an app folder (`walkAppFolder`): a dot-name (`.DS_Store`) or a `node_modules` left in the template never reaches an app
  const out = (rel: string) => (Object.hasOwn(RENAMED, rel) ? RENAMED[rel]! : rel)
  walkAppFolder(from, {
    dir: (rel) => void mkdirSync(join(to, out(rel))),
    file: (rel) => {
      if (rel === MANIFEST_FILE) return
      const buf = readFileSync(join(from, rel))
      const verbatim = rel === VERBATIM_DIR || rel.startsWith(VERBATIM_DIR + '/')
      writeFileSync(join(to, out(rel)), verbatim ? buf : fill(buf.toString('utf8'), extname(rel), spec))
    },
  })
}

/**
 * Placeholder substitution — filtered according to the syntax of where it is inserted. Because of
 * the character rule (#93), an id is safe to insert anywhere. The name and description are text a
 * person wrote, so they are escaped in HTML, and elsewhere (Markdown, a `//` comment in code) they
 * are inserted only as a single line (`normalizeName` already reduces them to one line).
 */
function fill(text: string, ext: string, spec: ScaffoldSpec): string {
  const esc = ext === '.html' ? escapeHtml : (s: string) => s
  return text.split(ID).join(spec.id).split(NAME).join(esc(spec.name)).split(DESCRIPTION).join(esc(spec.description))
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** Reduces a person-supplied name or description to one line — so a line break cannot cut off a code comment */
export function oneLine(s: string): string {
  return oneLineText(s)
}
