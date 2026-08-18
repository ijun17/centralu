import { closeSync, existsSync, openSync, renameSync, statSync, writeSync } from 'node:fs'

/**
 * host의 말을 **파일에 남긴다.**
 *
 * 여기가 없어서 하루를 잃었다. Tauri 수퍼바이저는 host의 stderr를 `Stdio::inherit`으로
 * 물려주는데, Finder로 띄운 `.app`의 stderr는 **아무 데도 가지 않는다**(/dev/null).
 * 그래서 세션이 왜 안 뜨는지 물으면 화면 문구 말고는 근거가 없었고, 그 문구가 하필
 * 원인을 덮는 문구였다("codex app-server exited"). 실제 원인은 codex가 stderr로 또박또박
 * 말하고 있었지만 그 줄이 닿는 곳이 없었다.
 *
 * `host-errors.log`가 있었지만 그건 **크래시 전용**이다 — 미처리 거절이나 예외가
 * 났을 때만 생긴다. 오늘처럼 아무것도 죽지 않고 조용히 어긋나는 경우엔 파일조차 안 생긴다.
 *
 * 그래서 stderr 전체를 받아 적는다. 터미널로 띄웠든 Finder로 띄웠든 같은 자리에 남는다.
 */

/** 한 파일이 이만큼 넘으면 한 세대 밀어낸다 */
export const MAX_LOG_BYTES = 8 * 1024 * 1024

/**
 * 넘치면 `.1`로 밀어낸다. 세대를 하나만 두는 이유: 로그는 **최근 것이 쓸모 있고**,
 * 무한정 쌓이면 사용자 폴더를 조용히 먹는다. 회전 자체가 실패해도 로깅은 계속되어야 한다 —
 * 로그를 못 남기는 것보다 큰 파일이 낫다.
 */
export function rotateIfLarge(path: string, maxBytes: number = MAX_LOG_BYTES): boolean {
  try {
    if (!existsSync(path) || statSync(path).size < maxBytes) return false
    renameSync(path, `${path}.1`)
    return true
  } catch {
    return false
  }
}

/** 지금 파일 크기 (없으면 0) */
function sizeOf(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}

/**
 * stderr를 파일로도 흘린다 (**가로채지 않고 겹쳐 쓴다**).
 *
 * 원래 stderr로도 그대로 내보낸다 — 터미널로 띄웠을 때 눈앞에서 사라지면
 * 개발 중에 더 불편해진다. 파일은 '또 하나의 청중'이지 대체재가 아니다.
 *
 * 실패는 **삼킨다.** 로그를 못 남기는 것이 host를 죽일 이유는 못 된다
 * (이 프로세스는 모든 세션의 부모다).
 *
 * **동기로 쓴다.** 스트림에 버퍼링을 맡기면 프로세스가 갑자기 끝날 때 마지막 몇 줄이
 * 통째로 사라지는데, 하필 그 몇 줄이 우리가 보려던 것이다. fd를 열어 두고 writeSync만
 * 하므로 매번 파일을 다시 여는 비용도 없다 — host의 stderr는 원래 한산하다.
 */
export function teeStderrToFile(path: string, maxBytes: number = MAX_LOG_BYTES): () => void {
  rotateIfLarge(path, maxBytes)
  let written = sizeOf(path)
  let fd: number | null = null
  try {
    fd = openSync(path, 'a')
  } catch {
    return () => {}
  }

  const original = process.stderr.write.bind(process.stderr)

  const roll = () => {
    try {
      if (fd !== null) closeSync(fd)
      renameSync(path, `${path}.1`)
      fd = openSync(path, 'a')
      written = 0
    } catch {
      /* 회전에 실패하면 그냥 계속 쓴다 — 큰 파일이 로그 없는 것보다 낫다 */
    }
  }

  process.stderr.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      if (fd !== null) writeSync(fd, text)
      written += Buffer.byteLength(text)
      if (written >= maxBytes) roll()
    } catch {
      /* 파일에 못 적어도 아래 원래 경로는 살아 있다 */
    }
    return original(chunk as never, enc as never, cb as never)
  }) as typeof process.stderr.write

  return () => {
    process.stderr.write = original
    try {
      if (fd !== null) closeSync(fd)
    } catch {
      /* 이미 닫혔으면 그만이다 */
    }
    fd = null
  }
}

/**
 * 기동 한 줄. **어느 빌드가 이 로그를 냈는지**를 로그 자신이 말하게 한다.
 *
 * 오늘 "지금 도는 앱이 어느 커밋 빌드냐"에 답하려고 바이너리 mtime과 커밋 시각을
 * 맞춰봐야 했다. 로그가 스스로 말하면 그 추측이 통째로 없어진다.
 *
 * 프로세스 시작을 **눈에 띄게** 가른다 — 한 파일에 여러 번의 실행이 이어 붙으므로,
 * 어디서부터가 이번 실행인지 한눈에 보여야 한다.
 */
export function startupBanner(info: { build: string; db: string; pid: number }): string {
  return [
    '',
    '='.repeat(72),
    `[agent-host] started ${new Date().toISOString()}`,
    `  build ${info.build}`,
    `  node  ${process.version}`,
    `  pid   ${info.pid}`,
    `  db    ${info.db}`,
    '='.repeat(72),
  ].join('\n')
}

/** 크래시 로그와 달리 이건 '늘 켜 있는' 로그다 — 파일 이름으로 구분된다 */
export function hostLogPath(dataDir: string): string {
  return `${dataDir}/host.log`
}

/** 파일 핸들을 열어두지 않고 한 줄만 덧붙인다 (종료 직전처럼 스트림을 못 믿을 때) */
export function appendLine(path: string, line: string): void {
  try {
    const fd = openSync(path, 'a')
    try {
      writeSync(fd, line.endsWith('\n') ? line : `${line}\n`)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* 로그도 못 남기는 상황이면 여기서 또 던지지 않는다 */
  }
}
