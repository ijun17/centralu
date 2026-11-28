/**
 * This tab's key from the person's trust (`host.trustDevTab`), in sessionStorage: it lives as long as the tab, survives
 * its reloads, and is gone once the tab is closed, which ends the trust (docs/security-boundaries/dev-browser-tabs.md)
 */
const KEY = 'centralu.devTabKey'

export const devTabKey = {
  read: (): string | null => sessionStorage.getItem(KEY),
  keep: (key: string): void => sessionStorage.setItem(KEY, key),
  forget: (): void => sessionStorage.removeItem(KEY),
}
