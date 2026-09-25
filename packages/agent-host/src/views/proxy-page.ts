import { createHash } from 'node:crypto'

/**
 * 샌드박스 프록시 페이지 (M4 B-3, 스파이크 S-1 `harness/static/sandbox.js`).
 *
 * 앱 화면은 두 겹의 iframe 안에서 돈다. 바깥이 이 페이지(host 포트의 출처)이고, 안쪽이 앱의
 * HTML이다. 이 페이지가 하는 일은 둘뿐이다. 안쪽 프레임을 규칙대로 만들고, 우리 화면(부모)과
 * 앱 화면(자식) 사이에서 메시지를 옮긴다.
 *
 * 스파이크가 정한 규칙을 그대로 따른다.
 *   - `sandbox`를 **먼저** 걸고 문서를 넣는다. 불투명 방식은 `srcdoc`이다. `document.write`는
 *     쓰지 않는다. 참조 호스트의 그 방식에서는 화면이 프록시의 출처를 물려받아, 다른 프록시의
 *     주소(비밀 경로 포함)와 저장소에 닿았다(실측).
 *   - 프레임은 출처가 아니라 `event.source`로 가린다. 불투명 출처는 모두 `"null"`이다.
 *     출처는 그다음에 한 번 더 본다. 안쪽이 불투명인데 `"null"`이 아닌 출처로 말하면, 무언가가
 *     안쪽 문서를 바꿔 끼운 것이다.
 *   - 부모의 출처는 `document.referrer`로 읽지 않는다. `tauri://`에서는 빈 값이다. host가
 *     허용 목록과 대조한 값을 페이지에 박아 넘긴다.
 *
 * 화면 HTML은 이 응답 안에 JSON으로 실려 온다. 규격의 참조 흐름은 부모가 `postMessage`로
 * HTML을 보내는 것이다(`sandbox-resource-ready`). 우리는 host가 문서를 직접 읽어 CSP와 같은
 * 응답에 싣는다. 그래서 정책과 문서가 한 곳에서 정해지고, 부모 화면은 앱의 HTML을 만지지 않는다.
 *
 * 메시지 순서: 부모(AppFrame)는 이 페이지를 싣기 **전에** 브리지를 연결해 둔다. iframe의
 * `contentWindow`는 이동해도 같은 객체라, 안쪽 화면의 첫 `ui/initialize`가 이미 듣고 있는
 * 브리지에 닿는다. 그래서 준비 신호(`sandbox-proxy-ready`)를 주고받지 않는다.
 */

export type ProxyPageConfig =
  | { mode: 'opaque'; hostOrigin: string; sandbox: string; allow: string; html: string }
  | { mode: 'app'; hostOrigin: string; sandbox: string; allow: string; src: string; appOrigin: string }

/**
 * 프록시 스크립트. 문자열로 두는 이유: 이것은 host가 아니라 **프록시 페이지 안에서** 도는
 * 코드다. 앱별 출처 방식에서는 CSP가 이 스크립트의 해시만 허용한다(`PROXY_SCRIPT_HASH`).
 */
export const PROXY_SCRIPT = `(function () {
  'use strict'
  var cfg = JSON.parse(document.getElementById('cc-view-config').textContent)
  var HOST = cfg.hostOrigin
  var inner = document.createElement('iframe')
  inner.setAttribute('sandbox', cfg.sandbox)
  if (cfg.allow) inner.setAttribute('allow', cfg.allow)
  inner.setAttribute('title', 'app view')
  document.body.appendChild(inner)
  var toInner = cfg.mode === 'app' ? cfg.appOrigin : '*'
  var innerOrigin = cfg.mode === 'app' ? cfg.appOrigin : 'null'
  window.addEventListener('message', function (e) {
    if (e.source === window.parent) {
      if (e.origin !== HOST) return
      if (inner.contentWindow) inner.contentWindow.postMessage(e.data, toInner)
      return
    }
    if (e.source === inner.contentWindow && e.source !== null) {
      if (e.origin !== innerOrigin) return
      window.parent.postMessage(e.data, HOST)
    }
  })
  if (cfg.mode === 'app') inner.src = cfg.src
  else inner.srcdoc = cfg.html
})()`

export const PROXY_SCRIPT_HASH = `sha256-${createHash('sha256').update(PROXY_SCRIPT).digest('base64')}`

/**
 * `<script type="application/json">` 안에 넣을 JSON. `<`를 이스케이프해 앱의 HTML이
 * `</script>`로 블록을 닫고 나오지 못하게 한다. JSON 문자열 안의 `\\u003c`는 같은 글자다.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * 프록시 페이지의 색 체계 — 호스트 화면과 같아야 한다(UI의 `html { color-scheme: dark }`, AppFrame이 화면에 넘기는 `theme: 'dark'`).
 *
 * 프록시를 싣는 iframe은 호스트 문서의 `dark`를 물려받는다. iframe과 그 안 문서의 색 체계가 다르면 Chromium은 안 문서의 바탕을
 * **불투명하게** 칠한다(CSS Color Adjustment: 어두운 곳에 박힌 밝은 문서가 읽히게 하려는 규칙). 색 체계를 말하지 않은 프록시는 밝은
 * 문서라 흰 캔버스가 앱 화면 전체를 덮었고, 호스트의 밝은 글자색을 쓰는 템플릿 화면은 흰 바탕 위에서 읽히지 않았다. 같은 체계를
 * 말하면 투명하다 — 안쪽 프레임도 `dark`를 물려받으므로, 받은 테마로 색 체계를 말하는 앱 화면(ext-apps의 `applyDocumentTheme`, 우리
 * 템플릿)도 투명하게 호스트의 바탕 위에 선다. 말하지 않는 앱은 Chromium이 제 밝은 캔버스를 깔아 준다(검은 기본 글자가 읽힌다).
 * WKWebView는 하위 프레임을 늘 투명하게 두므로 Tauri에서는 보이는 것이 바뀌지 않는다 — 이 페이지에는 iframe 말고 그릴 것이 없다.
 */
const HOST_COLOR_SCHEME = 'dark'

export function proxyPageHtml(config: ProxyPageConfig): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>app view</title>',
    `<meta name="color-scheme" content="${HOST_COLOR_SCHEME}">`,
    '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style>',
    '</head><body>',
    `<script type="application/json" id="cc-view-config">${embedJson(config)}</script>`,
    `<script>${PROXY_SCRIPT}</script>`,
    '</body></html>',
  ].join('')
}
