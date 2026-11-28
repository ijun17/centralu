import type { DevTab } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { GrantList } from './GrantList.jsx'
import { SettingsGroup } from './SettingsLayout.jsx'

/**
 * The dev browser tabs the person let send as them on a card (docs/security-boundaries/dev-browser-tabs.md), each until
 * its tab is closed or a day passes, and taken back here; a closed tab's stays listed until its day is over. Under Permissions with the other answers given once. Only a
 * developer running a dev preview ever has one, so the group shows only while one is trusted, or when the read failed:
 * hidden then, it would read as none trusted (#841)
 */
export function DevTabsSection() {
  const platform = usePlatform()
  const read = useLoad(() => platform.requests.devTabs(), [platform])
  if (!read.error && !read.data?.length) return null
  return (
    <SettingsGroup testId="dev-tabs" title="Trusted browser tabs" hint="Messages from these dev preview tabs read as yours. Closing a tab ends it; each is listed until a day after you allowed it.">
      <GrantList
        load={read}
        keyOf={(t: DevTab) => t.id}
        row={(t) => <span className="min-w-0 truncate font-mono text-sm text-ink">{t.origin}</span>}
        dateOf={(t) => t.grantedAt}
        action={{ label: 'Revoke', failed: 'Could not revoke it', testId: (t) => `revoke-dev-tab-${t.id}`, run: (t) => platform.requests.revokeDevTab(t.id) }}
        what="the trusted tabs"
        empty="No trusted browser tabs"
        testIds={{ list: 'dev-tabs-list', empty: 'dev-tabs-empty', failed: 'dev-tabs-failed', error: 'dev-tabs-error' }}
      />
    </SettingsGroup>
  )
}
