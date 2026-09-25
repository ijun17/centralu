/**
 * 앱 화면의 CSP (M4 B-3).
 *
 * 화면은 앱이 준 HTML이고, 앱이 `_meta.ui.csp`에 **선언한 곳에만** 닿을 수 있다. 선언이
 * 없으면 규격(SEP-1865)의 제한 기본값을 쓴다. 네트워크는 `connect-src 'none'`, 바깥 리소스와
 * 중첩 프레임도 없다. 참조 호스트(ext-apps basic-host)는 `connect-src 'self'`를 기본으로 준다.
 * 우리의 'self'는 host의 루프백 포트라서 그 기본을 따르지 않는다.
 *
 * 불투명 출처 방식에서는 이 문자열이 **프록시 페이지**의 헤더로 나간다. srcdoc 문서는 부모의
 * 정책을 물려받으므로, 화면의 정책을 정하는 자리는 프록시 페이지의 응답 하나뿐이다. 화면이
 * 자기 `<meta>`로 CSP를 더 걸 수는 있지만 이것보다 넓힐 수는 없다.
 */

export type ViewCspDomains = {
  connectDomains?: string[]
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}

export type ViewPermissions = {
  camera?: object
  microphone?: object
  geolocation?: object
  clipboardWrite?: object
}

/**
 * 선언 하나가 받아들일 모양. `scheme://host[:port][/path]`만 받는다.
 *
 * 규격은 "도메인"이라고만 적는다. 그래서 CSP 문법상 허용되는 더 넓은 모양은 모두 거절한다.
 *   `*`, `https:`, `data:`                    출처가 아니라 전부이거나 체계 전체다
 *   `'unsafe-eval'` 같은 키워드               도메인 선언으로 정책을 바꾸는 길이다
 *   공백·`;`·`,`가 든 값                        지시문을 하나 더 끼워 넣는 길이다
 *
 * 루프백(`localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`)도 거절한다. 그 주소에는 host의 비밀
 * 경로 뒤 길과 다른 앱의 앱별 출처 포트가 산다. 화면이 거기 닿을 이유가 없다. 로컬 서비스와
 * 이야기해야 하는 앱은 앱 서버가 대신 부른다(상태와 바깥 호출은 서버에 둔다는 이 설계의 원칙).
 */
const SOURCE = /^(https?|wss?):\/\/(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(:(\d{1,5}|\*))?(\/[a-z0-9._~%/-]*)?$/i

function isLoopback(source: string): boolean {
  const host = source.replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0'
}

/** 선언 목록을 가른다. 받은 것만 정책에 들어가고, 버린 것은 host 로그에 남는다 */
export function sanitizeDomains(list: unknown): { kept: string[]; dropped: string[] } {
  const kept: string[] = []
  const dropped: string[] = []
  if (!Array.isArray(list)) return { kept, dropped }
  for (const item of list) {
    if (typeof item === 'string' && SOURCE.test(item) && !isLoopback(item)) {
      if (!kept.includes(item)) kept.push(item)
    } else {
      dropped.push(typeof item === 'string' ? item : JSON.stringify(item))
    }
  }
  return { kept, dropped }
}

export type ApprovedCsp = {
  /** 정책 문자열 (응답 헤더에 그대로) */
  policy: string
  /** 받아들인 선언 — 화면에 호스트가 승인한 것으로 알려 준다 (`hostCapabilities.sandbox.csp`) */
  approved: Required<ViewCspDomains>
  /** 버린 선언 — "왜 이 이미지가 안 뜨나"의 답이라 로그에 남긴다 */
  dropped: string[]
}

/**
 * 화면의 CSP.
 *
 *   default-src 'none'                    적지 않은 것은 모두 막는다
 *   script/style 'unsafe-inline'          화면은 인라인 HTML이다 (규격 기본값과 같다)
 *   img/media/font data:, blob:           페이지 안에서 만든 데이터라 네트워크가 아니다
 *   connect/frame 'none'                  선언이 있을 때만 그 출처들로 연다
 *   form-action 'none'                    폼 제출은 connect-src를 지나지 않는 유출 길이다
 *   object-src 'none'
 *   base-uri 'self'                       규격 기본값
 *
 * 'self'를 리소스 지시문에 넣지 않는다. 불투명 출처에서 'self'는 프록시의 출처(host 포트)를
 * 가리키는데, 거기에는 화면을 위한 것이 없다. 'unsafe-eval'도 넣지 않는다(규격 기본값에 없다).
 * S-1에서 공식 예제 앱이 이 조건으로 돌았다.
 */
export function buildViewCsp(csp: ViewCspDomains | undefined): ApprovedCsp {
  const connect = sanitizeDomains(csp?.connectDomains)
  const resource = sanitizeDomains(csp?.resourceDomains)
  const frame = sanitizeDomains(csp?.frameDomains)
  const base = sanitizeDomains(csp?.baseUriDomains)
  const r = resource.kept.join(' ')
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ')
  const policy = [
    "default-src 'none'",
    `script-src ${join("'unsafe-inline'", r)}`,
    `style-src ${join("'unsafe-inline'", r)}`,
    `img-src ${join('data: blob:', r)}`,
    `font-src ${join('data:', r)}`,
    `media-src ${join('data: blob:', r)}`,
    `worker-src ${join('blob:', r)}`,
    `connect-src ${connect.kept.length ? connect.kept.join(' ') : "'none'"}`,
    `frame-src ${frame.kept.length ? frame.kept.join(' ') : "'none'"}`,
    "form-action 'none'",
    "object-src 'none'",
    `base-uri ${base.kept.length ? base.kept.join(' ') : "'self'"}`,
  ].join('; ')
  return {
    policy,
    approved: {
      connectDomains: connect.kept,
      resourceDomains: resource.kept,
      frameDomains: frame.kept,
      baseUriDomains: base.kept,
    },
    dropped: [...connect.dropped, ...resource.dropped, ...frame.dropped, ...base.dropped],
  }
}

/**
 * 앱별 출처 방식의 **프록시 페이지** CSP. 이때 화면은 프록시가 아니라 자기 포트에서 온다.
 * 그래서 프록시 자신은 인라인 스크립트 하나(해시로 고정)와 그 한 출처의 프레임만 필요하다.
 *
 * `frame-src`가 프록시의 자식 프레임이 **갈 수 있는 곳**도 정한다. 화면이 자기 프레임을 다른
 * 곳으로 보내 값을 흘리는 길(`location = 'https://…?data'`)이 여기서 막힌다. 불투명 방식에서는
 * 위 `frame-src`(선언한 곳만)가 같은 일을 한다.
 */
export function buildProxyCsp(scriptHash: string, appOrigin: string): string {
  return [
    "default-src 'none'",
    `script-src '${scriptHash}'`,
    "style-src 'unsafe-inline'",
    `frame-src ${appOrigin}`,
    "form-action 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/**
 * iframe `allow` 속성 — 앱이 선언한 기능만 넘긴다. ext-apps의 `buildAllowAttribute`와 같은
 * 순서와 이름이다(카메라, 마이크, 위치, 클립보드 쓰기). 모르는 키는 버린다.
 */
export function allowAttribute(permissions: ViewPermissions | undefined): string {
  if (!permissions || typeof permissions !== 'object') return ''
  const out: string[] = []
  if (permissions.camera) out.push('camera')
  if (permissions.microphone) out.push('microphone')
  if (permissions.geolocation) out.push('geolocation')
  if (permissions.clipboardWrite) out.push('clipboard-write')
  return out.join('; ')
}

/** 받아들인 권한만 되돌려 준다 (`hostCapabilities.sandbox.permissions`) */
export function approvedPermissions(permissions: ViewPermissions | undefined): ViewPermissions {
  const out: ViewPermissions = {}
  if (!permissions || typeof permissions !== 'object') return out
  if (permissions.camera) out.camera = {}
  if (permissions.microphone) out.microphone = {}
  if (permissions.geolocation) out.geolocation = {}
  if (permissions.clipboardWrite) out.clipboardWrite = {}
  return out
}
