// Extension to vscode-icons (MIT) icon, so the kind registers before the name is read. A subset: anything missing falls
// back to the default file icon, never a blank, so the table may lag safely. Whole names (`Dockerfile`) are checked first.
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

/** Known by the whole name, not an extension */
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

export function iconForFile(name: string): string {
  const lower = name.toLowerCase()
  const byName = BY_NAME[lower]
  if (byName) return byName

  const dot = lower.lastIndexOf('.')
  // A leading dot is part of the name, not an extension (.env)
  if (dot <= 0 || dot === lower.length - 1) return DEFAULT_FILE_ICON
  return BY_EXT[lower.slice(dot + 1)] ?? DEFAULT_FILE_ICON
}
