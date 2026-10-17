import { describe, expect, it } from 'vitest'
import { consentKindLabel } from './ProjectConsentsSection.jsx'

// A consent kind a newer host added (#844) reaches this list through the tolerant read, as the word it came as
describe('consentKindLabel', () => {
  it('says what each known kind allows', () => {
    expect(consentKindLabel('delegate')).toBe('may ask')
    expect(consentKindLabel('apps')).toBe('may use the apps of')
    expect(consentKindLabel('agents')).toBe('sessions may start agents')
  })

  it('says a kind it has no words for by its own word, never as a gap', () => {
    expect(consentKindLabel('terminals')).toBe('may terminals')
  })
})
