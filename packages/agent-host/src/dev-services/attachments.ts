import { mkdir, writeFile, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Attachment } from '@cc/protocol'
import { dataRoot } from '../data-dir.js'

/**
 * 첨부 저장 (D-1).
 *
 * 이미지를 base64로 DB에 넣지 않는다 — 대화 기록이 급격히 커지고 FTS 인덱스가 오염된다.
 * 파일로 저장하고 경로만 주고받는다. 세션을 지우면 함께 정리된다.
 */
// **함수다.** 모듈 로드 시점에 정하면 host가 데이터 폴더를 고정하기 전의 값이 박힌다
const root = () => join(dataRoot(), 'attachments')

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

export async function saveAttachment(
  sessionId: string,
  name: string,
  mime: string,
  dataBase64: string,
): Promise<Attachment> {
  const dir = join(root(), sessionId)
  await mkdir(dir, { recursive: true })
  const ext = extname(name) || EXT[mime] || ''
  const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
  const buf = Buffer.from(dataBase64, 'base64')
  await writeFile(file, buf)
  return { kind: mime.startsWith('image/') ? 'image' : 'file', path: file, name, mime, bytes: buf.length }
}

/** 세션 아카이브·삭제 시 함께 정리 */
export async function clearAttachments(sessionId: string): Promise<void> {
  await rm(join(root(), sessionId), { recursive: true, force: true })
}

/** 총량 상한 — 이미지가 영속되면서(#40) 무한히 쌓일 수 있게 됐다. 사용자 결정: 500MB */
export const ATTACHMENTS_MAX_BYTES = 500 * 1048576

/**
 * 상한을 넘으면 **오래된 파일부터** 지운다. DB의 경로 참조는 남는다 — 지워진
 * 이미지는 화면에서 "정리됨" 상자가 되고, 그 상자가 이 정책의 존재를 말해준다.
 */
export async function sweepAttachments(maxBytes: number = ATTACHMENTS_MAX_BYTES): Promise<number> {
  const { readdir, stat, rm: rmFile } = await import('node:fs/promises')
  const files: { path: string; size: number; mtime: number }[] = []
  let dirs: string[]
  try {
    dirs = await readdir(root())
  } catch {
    return 0 // 폴더가 아직 없다 — 지울 것도 없다
  }
  for (const d of dirs) {
    const dir = join(root(), d)
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      const p = join(dir, name)
      const s = await stat(p).catch(() => null)
      if (s?.isFile()) files.push({ path: p, size: s.size, mtime: s.mtimeMs })
    }
  }
  let total = files.reduce((a, f) => a + f.size, 0)
  if (total <= maxBytes) return 0
  files.sort((a, b) => a.mtime - b.mtime)
  let removed = 0
  for (const f of files) {
    if (total <= maxBytes) break
    await rmFile(f.path, { force: true }).catch(() => {})
    total -= f.size
    removed++
  }
  return removed
}
