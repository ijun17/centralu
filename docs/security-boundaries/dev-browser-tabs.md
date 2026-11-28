# A dev browser tab the person trusted

A `pnpm dev:live` page holds the limited credential ([local-data-and-transport.md](local-data-and-transport.md),
[credentials.md](credentials.md)), so what is sent from it is stored, shown and relayed as a script's. The person may
let one such tab send as them (#2469; owner, 2026-11-29: until the tab is closed, at most 24 hours, revocable from
Settings). This file is that path: what it gives, what holds it, and what it leaves open.

## What it gives, and what it does not

- **Attribution only.** A trusted socket's calls carry `RpcContext.trustedDev`, which `scriptAuthor` (`rpc.ts`) and the
  router's `SCRIPT_TEXT` check (`links/router.ts`) read: its text is the person's. Its rights stay the limited
  credential's (`transport/method-rights.ts`): the person's answers, mail, settings and the window's lists stay refused,
  and what cannot be undone still raises a card in the app's window.
- **Linked computers.** A trusted tab's text goes to a linked computer as the person's, as a window's does; an untrusted
  one's is refused there (`SCRIPT_TEXT`). The card says so.

## What holds it

- **The one owner** is `transport/dev-tabs.ts` (`DevTabs`). The transport asks it at every call whether the socket is
  trusted; nothing else keeps a trust.
- **The person's Allow, on a code the host chose.** `host.devTabCode` gives the socket a code the host drew; the tab
  shows it, and `host.trustDevTab` raises the card with that code and the tab's `Origin` (`host-requests.ts`). A code
  the host did not give that socket is refused, and one code raises one card. The person compares the two codes.
- **Only a dev tab may ask.** The `Origin` must be one of the four local Vite origins, the credential the plain limited
  one (not a session's), and the host a desktop host (a `centralu serve` host has no `DevTabs` and refuses).
- **A key bound to the tab.** On Allow the host answers 32 random bytes as the key and keeps only its SHA-256 with the
  origin and an expiry 24 hours on. The tab keeps the key in sessionStorage, which lives as long as the tab, survives
  its reloads and is dropped when it closes; it presents the key in each hello (`hello.devTabKey`). The host restores
  the trust only for a key it issued to that origin, unexpired and not taken back, on a hello with the plain limited
  credential.
- **Every tab with the key.** Each socket that presents the key holds the grant: a duplicated tab, or one `window.open`
  made, copies sessionStorage and sends as the person too, as its `hello_ok.trustedDev` says (#2569 review). Taking the grant back or its expiry ends it for all of them; the 24 hours are
  the grant's, not each tab's. A second Allow from a tab replaces the grant that tab held, unless another tab still
  holds it.
- **Revocable.** Settings → Permissions lists the trusted tabs (`host.devTabs`, window only) and takes one back
  (`host.revokeDevTab`); the next call of every socket holding it is a script's, and the key restores nothing. host.log
  says each grant and revoke by the grant's id and origin, never the key (`[dev-tabs]`).
- **Nothing at rest.** The keys live in the host's memory: a restart of the host (an update, a swap, a crash) ends every
  trust, and the tab drops its key at the next hello that does not restore it and offers the trust again. A stored key
  would be a credential on disk that outlives the tab it was given to.
- **No card in the tab.** A socket holding the limited credential is sent no card's events (`HostServer.sees`): it
  cannot answer one, so the events would only redraw cards it has no use for. This does not keep their text from it:
  `requests.list` is everyday, so any limited caller reads every pending card (#2581).

## What it leaves open

- **Any local program can raise the card.** The `Origin` header is the client's word, and every process of the user
  holds the limited credential. Such a program gets its own code from the host and raises a card showing it; only the
  person's comparison of the card's code with the tab's stops it. An Allow given without comparing gives that program
  the person's attribution for at most 24 hours.
- **A key read from the tab.** Anything that reads the tab's sessionStorage (a script on the dev page, the browser
  profile on disk while the tab is open) holds the trust beside the tab until it expires or is taken back.
- **A reopened tab.** A browser that reopens a closed tab ("Reopen closed tab", or a restored session) may bring back its
  sessionStorage, and with it the key: the trust then outlives the close, still bounded by the grant's 24 hours.
- **Closing the tab ends the key, not the grant.** The host cannot see a tab close from a reload, so the grant stays
  listed in Settings, unusable, until its 24 hours pass or it is taken back.
- **A revoked or expired tab is not told.** It keeps working as a script's; its banner offers the trust again only at
  its next reconnect.
