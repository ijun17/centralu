/**
 * 확장자 → vscode-icons 아이콘.
 *
 * 아이콘은 vscode-icons(MIT)에서 가져왔다 — 익숙한 그림이라 이름을 읽기 전에 종류가 잡힌다.
 * 전체 1,200여 개를 다 넣지는 않는다. 앱 크기를 그만큼 쓸 이유가 없고,
 * **표에 없으면 기본 파일 아이콘으로 떨어지므로 빠뜨려도 빈칸이 되지 않는다.**
 * 이게 이 표를 안심하고 둘 수 있는 이유다 — 목록이 못 따라와도 화면은 멀쩡하다.
 *
 * 이름은 파일 전체로 먼저 본다: `Dockerfile`·`.gitignore`처럼 확장자가 아니라
 * 이름 자체가 종류인 것들이 있다.
 */
import defaultFile from '../../assets/file-icons/default_file.svg'
import ts from '../../assets/file-icons/file_type_typescript.svg'
import tsx from '../../assets/file-icons/file_type_reactts.svg'
import js from '../../assets/file-icons/file_type_js.svg'
import jsx from '../../assets/file-icons/file_type_reactjs.svg'
import json from '../../assets/file-icons/file_type_json.svg'
import css from '../../assets/file-icons/file_type_css.svg'
import scss from '../../assets/file-icons/file_type_scss.svg'
import html from '../../assets/file-icons/file_type_html.svg'
import md from '../../assets/file-icons/file_type_markdown.svg'
import image from '../../assets/file-icons/file_type_image.svg'
import svg from '../../assets/file-icons/file_type_svg.svg'
import rust from '../../assets/file-icons/file_type_rust.svg'
import go from '../../assets/file-icons/file_type_go.svg'
import python from '../../assets/file-icons/file_type_python.svg'
import ruby from '../../assets/file-icons/file_type_ruby.svg'
import shell from '../../assets/file-icons/file_type_shell.svg'
import yaml from '../../assets/file-icons/file_type_yaml.svg'
import toml from '../../assets/file-icons/file_type_toml.svg'
import sql from '../../assets/file-icons/file_type_sql.svg'
import text from '../../assets/file-icons/file_type_text.svg'
import font from '../../assets/file-icons/file_type_font.svg'
import pdf from '../../assets/file-icons/file_type_pdf.svg'
import video from '../../assets/file-icons/file_type_video.svg'
import audio from '../../assets/file-icons/file_type_audio.svg'
import zip from '../../assets/file-icons/file_type_zip.svg'
import java from '../../assets/file-icons/file_type_java.svg'
import c from '../../assets/file-icons/file_type_c.svg'
import cpp from '../../assets/file-icons/file_type_cpp.svg'
import swift from '../../assets/file-icons/file_type_swift.svg'
import kotlin from '../../assets/file-icons/file_type_kotlin.svg'
import php from '../../assets/file-icons/file_type_php.svg'
import vue from '../../assets/file-icons/file_type_vue.svg'
import svelte from '../../assets/file-icons/file_type_svelte.svg'
import docker from '../../assets/file-icons/file_type_docker.svg'
import git from '../../assets/file-icons/file_type_git.svg'
import log from '../../assets/file-icons/file_type_log.svg'
import wasm from '../../assets/file-icons/file_type_wasm.svg'

export const DEFAULT_FILE_ICON = defaultFile

/** 이름 자체가 종류인 것들 — 확장자로는 잡히지 않는다 */
const BY_NAME: Record<string, string> = {
  dockerfile: docker,
  '.dockerignore': docker,
  '.gitignore': git,
  '.gitattributes': git,
  '.gitmodules': git,
}

const BY_EXT: Record<string, string> = {
  ts: ts, mts: ts, cts: ts, tsx,
  js, mjs: js, cjs: js, jsx,
  json, jsonc: json, json5: json,
  css, scss, sass: scss, less: css,
  html, htm: html,
  md, mdx: md, markdown: md,
  png: image, jpg: image, jpeg: image, gif: image, webp: image, ico: image, avif: image, bmp: image,
  svg,
  rs: rust, go, py: python, rb: ruby,
  sh: shell, bash: shell, zsh: shell, fish: shell,
  yml: yaml, yaml,
  toml, sql,
  txt: text, log,
  woff: font, woff2: font, ttf: font, otf: font,
  pdf,
  mp4: video, mov: video, webm: video, avi: video,
  mp3: audio, wav: audio, flac: audio, ogg: audio,
  zip, tar: zip, gz: zip, rar: zip, '7z': zip,
  java, c, h: c, cpp, cc: cpp, hpp: cpp, cxx: cpp,
  swift, kt: kotlin, kts: kotlin, php, vue, svelte,
  wasm,
}

/** 파일 이름 하나로 아이콘을 정한다. 모르면 기본 파일 아이콘 — 빈칸은 없다 */
export function iconForFile(name: string): string {
  const lower = name.toLowerCase()
  const byName = BY_NAME[lower]
  if (byName) return byName

  const dot = lower.lastIndexOf('.')
  // 맨 앞의 점은 확장자가 아니라 이름의 일부다 (.env)
  if (dot <= 0 || dot === lower.length - 1) return DEFAULT_FILE_ICON
  return BY_EXT[lower.slice(dot + 1)] ?? DEFAULT_FILE_ICON
}
