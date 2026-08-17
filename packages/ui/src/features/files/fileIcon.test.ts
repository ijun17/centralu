import { describe, expect, it } from 'vitest'
import { DEFAULT_FILE_ICON, iconForFile } from './fileIcon.js'

/**
 * 이 표는 하드코딩된 목록이다 — 그래서 **못 따라왔을 때 어떻게 되는지**가 제일 중요하다.
 * 모르는 확장자가 빈칸이 되면 목록이 망가지지만, 기본 아이콘으로 떨어지면 멀쩡하다.
 */
describe('iconForFile', () => {
  it('아는 확장자는 제 아이콘을 쓴다', () => {
    expect(iconForFile('App.tsx')).not.toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('main.rs')).not.toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('logo.svg')).not.toBe(DEFAULT_FILE_ICON)
  })

  it('같은 계열은 같은 아이콘을 공유한다', () => {
    expect(iconForFile('a.jpg')).toBe(iconForFile('b.png'))
    expect(iconForFile('a.yml')).toBe(iconForFile('b.yaml'))
    expect(iconForFile('a.ts')).toBe(iconForFile('b.mts'))
  })

  it('처음 보는 확장자는 기본 파일 아이콘 — 빈칸이 되지 않는다', () => {
    expect(iconForFile('main.zig')).toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('page.astro')).toBe(DEFAULT_FILE_ICON)
  })

  it('확장자가 없어도 기본 파일 아이콘', () => {
    expect(iconForFile('LICENSE')).toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('Makefile')).toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('weird.')).toBe(DEFAULT_FILE_ICON)
  })

  it('이름 자체가 종류인 것들 — 확장자로는 안 잡힌다', () => {
    expect(iconForFile('Dockerfile')).not.toBe(DEFAULT_FILE_ICON)
    expect(iconForFile('.gitignore')).not.toBe(DEFAULT_FILE_ICON)
    // 맨 앞의 점은 확장자가 아니다
    expect(iconForFile('.env')).toBe(DEFAULT_FILE_ICON)
  })

  it('대소문자를 가리지 않는다 — README.MD도 마크다운이다', () => {
    expect(iconForFile('README.MD')).toBe(iconForFile('readme.md'))
    expect(iconForFile('DOCKERFILE')).toBe(iconForFile('Dockerfile'))
  })

  it('점이 여러 개면 마지막 것을 쓴다', () => {
    expect(iconForFile('types.d.ts')).toBe(iconForFile('x.ts'))
  })
})
