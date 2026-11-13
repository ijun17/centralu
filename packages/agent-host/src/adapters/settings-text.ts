import { realOs } from '../os/real.js'

/** Reads a file's text; rejects when there is none. A test passes its own, so no file is read */
export type ReadText = (path: string) => Promise<string>

/**
 * A tool's own settings file as text, through the OS layer: what an adapter reads of the person's configuration (Claude's `settings.json`, Codex's
 * `config.toml`) to know where the tool's turns go (`AgentAdapter.apiUrl`, #1415)
 */
export const readSettingsText: ReadText = (path) => realOs().files.promises.readFile(path, 'utf8')
