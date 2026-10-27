import { describe, expect, it } from 'vitest'
import { splitRunTogetherHeadings } from './reasoning-headings.js'

describe('splitRunTogetherHeadings (#1464)', () => {
  it('puts a blank line between headings stored run together (the issue\'s stored rows)', () => {
    expect(splitRunTogetherHeadings('**Checking projects child process****흰 화면의 초기화 로그를 확인합니다.**')).toBe(
      '**Checking projects child process**\n\n**흰 화면의 초기화 로그를 확인합니다.**',
    )
    expect(splitRunTogetherHeadings('**검증 기록 출처를 확인합니다****Awaiting RPC verification**')).toBe(
      '**검증 기록 출처를 확인합니다**\n\n**Awaiting RPC verification**',
    )
  })

  it('mends every join in a row, paragraphs between them kept', () => {
    expect(splitRunTogetherHeadings('**A**\n\nbody****B**')).toBe('**A**\n\nbody**\n\n**B**')
    expect(splitRunTogetherHeadings('**A****B****C**')).toBe('**A**\n\n**B**\n\n**C**')
  })

  it('leaves a row that is already apart, and text with no join, as it is', () => {
    const apart = '**A**\n\n**B**'
    expect(splitRunTogetherHeadings(apart)).toBe(apart)
    expect(splitRunTogetherHeadings('plain **bold** text')).toBe('plain **bold** text')
    expect(splitRunTogetherHeadings('a ****')).toBe('a ****')
  })
})
