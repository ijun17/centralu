# App views

A view is an app's HTML running inside the desktop window, isolated in layers. Browser e2e
(Chromium) covers the frame rules; the Tauri window was measured by hand (spikes S-1 and S-2,
#186).

**The proxy sits behind a per-launch secret.** Every HTTP route on the host's loopback port is
behind a 32-byte random path segment made at each launch, a different value from the WebSocket
token (`transport/http.ts`). Under the keeper the segment is instead derived from the keeper's token
(HMAC-SHA256 under a fixed label, base64url, 43 characters; `deriveHttpSecret`), so that every host
the keeper starts has the same one and a view's address survives the host's restarts under one keeper (#280 step 4). It
is still a different value from the token, and one-way from it: a leaked view address gives nothing
toward the RPC door. The other direction was never a boundary, since whoever holds the token can
already ask `apps.viewFrame` for an address carrying the secret. It lives as long as the keeper's
token, and a keeper restart changes both. Without it, or with a wrong one, a request gets the same 404 as a path
that does not exist, in status, body and headers (77 method and path combinations in #150;
`server.test.ts` "reaching it without the secret is nothing but 404, indistinguishable between a
wrong secret and a nonexistent route"). The comparison is constant-time over hashes. Every
response sends `Referrer-Policy: no-referrer`, so a view cannot read the secret from its referrer.
A frame address is given only to a parent on the WebSocket origin allowlist (`view-host.ts`
`frame`; "gives no address to a parent origin outside the allow list, and 404s even when the
address is tampered with"). Under the keeper the address names the front door's port rather than
the host's (`keeper-control.ts` `viewPort`); the door relays the request unread, so the host applies
exactly the same secret and allowlist checks. The desktop CSP opens frames to `http://127.0.0.1:*`
and nothing wider (`tooling/desktop-csp.test.ts`): the port changes every launch, and the secret
locks the path.

**Opaque origin by default.** The proxy page, on the host port's origin rather than our UI's,
creates the inner frame with `sandbox="allow-scripts allow-forms"` set **before** it gives the
frame the HTML through `srcdoc` (`views/proxy-page.ts`). It never uses `document.write`: in the
reference host that let the view inherit the proxy's origin and reach other proxies' addresses,
secret paths included, and their storage (measured, S-1). The inner document's origin is `"null"`:
no parent or top window, no storage or cookies, no popups, no top navigation, no fetch, WebSocket
or image from the host port, and navigating itself elsewhere is blocked by the `frame-src` of the
proxy page's header, which in this mode is the view's own policy (`buildViewCsp`: `'none'` unless
declared). A frame's navigation is checked against the document that embeds it, so the view's
`frame-src` stops it only because that document is the proxy page here
(`e2e/app-frame.spec.ts` "S-2 (browser part): an app frame cannot reach the parent, the top window,
storage, popups, or the host network", "which CSP stops a frame navigating itself outward", and
"opaque mode: the inner frame's origin is "null", and it cannot read the proxy's secret address").
The outer frame has
`allow-scripts allow-same-origin allow-forms` so that the per-app mode can work; its origin is
the host port's, not our UI's, so it cannot touch our window.

**Per-app origin, when an app asks.** `view.origin: "app"` in the manifest gives the inner frame
`allow-same-origin` on `http://127.0.0.1:<port>`: a real origin, so browser storage works. The
port is fixed per (project, app) and never given to another app, because WebKit keeps storage per
origin and a reused port would hand one app another's storage. The port book (`views/origin-ports.ts`,
kept in app settings under `apps.viewPorts`) only grows; a port another program holds is retired
for good and the app moves, losing what it stored there. Every change re-reads the book and
writes it in one transaction, so apps starting at once, or the old and new host of a swap, each keep
their own entry; a port another entry claimed while it was being bound is given up. Ports come from 20000–32767, clear of the
macOS and Linux ephemeral ranges, and listen on 127.0.0.1 only. The port serves only that app's
instances, behind a secret derived per app from the host secret (HMAC), so a view reading its own
`location.href` learns nothing that opens another app's route; the proxy page there allows only
its own script hash and that one frame origin (`origin-ports.test.ts`; `view-host.test.ts`
"per-app origin"; `e2e/app-frame.spec.ts` "per-app origin mode: gets a real origin on its own
port, storage is separated per app, and reopening gets the same origin"). That one frame origin
is also what stops the view navigating its own frame outward in this mode: the view's own policy
cannot, since a frame's navigation is checked against the proxy page that embeds it
(`buildProxyCsp`; `e2e/app-frame.spec.ts` "which CSP stops a frame navigating itself outward").

**A linked machine's views are served by the hub** (#82, [plans/remote-hub.md](../plans/remote-hub.md) §11). Storage
lives in the window that renders a view, so the port has to come from the book of the host whose window shows it: a
machine's own ports would collide with the hub's in the one WebKit that holds both. The hub keys a machine's app as
`<machine>.<that machine's key>` in its own book, asks the machine only for the app's raw resource
(`apps.viewDocument`), and builds the CSP, sandbox and proxy page itself, so a loopback entry is dropped by the hub's
rule whatever the machine's build does. The machine's answer must name a project of its own machine or none; one
naming another machine's project is "not open" (`links/linked-views.test.ts`). No address of the machine reaches the
window, and the machine's HTTP secret never leaves it. A machine removed and another linked under the same name gets
the same machine id, and so the old origins and their storage: accepted (owner, 2026-10-11), as for a local app made
again under the same id.

**CSP.** A view's policy is assembled from its resource's `_meta.ui.csp` (`views/csp.ts`) and sent
as a header on the proxy page, which the `srcdoc` document inherits: the view can tighten it with
its own `<meta>`, never widen it. By default: `default-src 'none'`; inline script and style;
`data:` and `blob:` for images, media, fonts and workers; `connect-src` and `frame-src` `'none'`
unless declared; `form-action 'none'`; `object-src 'none'`. `'self'` is not a source: under the
opaque origin it would mean the host port. A declared entry must be `scheme://host[:port][/path]`
with http(s) or ws(s) (a `*.` subdomain or a `:*` port is allowed). A bare `*`, bare schemes,
keywords, anything containing a space, `;` or `,`, and hosts of this machine (loopback, unspecified and
link-local, also with a trailing dot or inside a `::`-compatible or NAT64 IPv6 address: where the host's routes and other apps' ports live, and cloud metadata; the same check an
import's download address goes through) are dropped, and the drop is logged. A declared host is parsed the way a
browser parses a URL (WHATWG) before it is checked, and the policy carries that canonical form, so
`127.1`, `2130706433` and `0x7f000001` are read as `127.0.0.1` and dropped (#407). This is
hardening, not a closed hole: CSP host matching is literal, and Chromium and WebKit (Playwright)
blocked every fetch to `127.0.0.1` under a policy that listed only those other spellings, while a
policy listing `127.0.0.1` let each spelling through. The frame's `allow` attribute passes
only a declared camera, microphone, geolocation or clipboard-write (`csp.test.ts`). The manifest's
own `csp` field is not used.

**The frame decides, not the message.** The proxy relays only messages whose `event.source` is its
parent, with the host origin it was given explicitly (never `document.referrer`, which is empty
under `tauri://`), or its own inner frame, with origin `"null"` or the app's origin; a replaced
inner document is dropped. In the UI, the bridge listens only to its own iframe (`AppFrame.tsx`)
and sends every tool call and resource read under the component's own app, project and instance
(`e2e/app-frame.spec.ts` "a message that claims a different app cannot change which app the call
is attributed to": another app named in the SDK's `_meta`, raw JSON-RPC with extra fields, and a
message posted straight to the top window all fail). On the host, a view instance fixes its app:
asking for a frame or a resource under another app's name is "not open" (`view-host.test.ts` "the
instance decides which app the view belongs to — presenting a different app name or project does
not open it").

**A view shows only its own app's screen.** An inline view opens only if the `ui://` its tool
declares is in that app's `resources/list`, and closes if the call's result points elsewhere
(`inline-views.ts`; "a tool that declares someone else's view opens nothing and leaves a
rejection — the call still completes", "closes and rejects the opened view when the result points
to someone else's view"). Documents are read only from the
instance's own app process, so a pinned view's `home` result cannot name another app's screen
either (`app-home-view.ts`).

**Links** open only for `http(s):` and `mailto:`, only after the person confirms, and outside
Centralu with `noopener,noreferrer` (`AppFrame.tsx`; "a link opens through the platform's
external-open port after the person confirms it, and anything that is not http(s) or mailto is
refused without even asking"). A view's tool calls are not approved one by one:
the view is the control surface the app offers the person. They are recorded as `view`.

Limits:

- The e2e runs in Chromium. WKWebView and the Tauri window were measured by hand in the spikes and
  in #186, not in CI.
- `apps.invoke` does not check on its own that a view of that app is open; it trusts its caller,
  the UI, the only holder of the WebSocket token. The app is fixed in the UI (`AppFrame`), not
  derived again by the host.
- In dev and web mode, where the top page is `http://127.0.0.1`, cookies are shared across all
  ports (measured in Chromium, WebKit and WKWebView, S-1); localStorage and IndexedDB are not. The
  per-app origin separates storage by origin only.
- A view might rewrite its own `referrer` meta and send the proxy's address to a domain it
  declared in `connectDomains`. Not measured yet (#150).
- A declared `connectDomains` entry is a real way out for anything the view holds. The CSP limits
  where data can go, not what.
- The host adds a drag relay to every view's document (#308, apps.md §6.7): a few lines that post a
  dragged item's `text/uri-list` and `text/plain`, and where the drag ended, to the view's parent.
  It runs with the view's own privileges and posts nothing the view could not post itself. The UI
  reads both messages as the app's words: it checks their shape, counts an end only after a start
  from the same frame and while that frame holds the page's focus (a press in it), and only ever
  puts a link or text into a composer's draft, never sends it. An app the person is pressing in at
  that moment could still post an end pointing at a session of its choosing; what it gets is text
  in a draft the person sees before sending.
- Open view instances survive a stop for an update (`view-handover.ts`): the leaving host writes each instance's id, app and `ui://` address (nothing the app
  returned) to the store under `views.handover`, and the next host reopens them under the same ids if the record is
  at most ten minutes old, then deletes it. Each reopened instance holds its app as a fresh one
  does and must still match its app on every request; a view in a conversation is re-bound to its
  card so its messages still go only there. An instance id is a bearer handle to that one view for
  whoever holds the WebSocket token, as it was before; it now lives across an update too.
