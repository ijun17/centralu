import { describe, expect, it } from 'vitest'
import { bytesText } from './bytes-text.js'

describe('bytesText', () => {
  it('says bytes as they are, and larger counts in steps of 1024 labelled KB, MB and GB, one decimal below 10', () => {
    expect([0, 512, 1023].map(bytesText)).toEqual(['0 B', '512 B', '1023 B'])
    expect([1024, 1536, 10 * 1024, 12 * 1048576, 1048576].map(bytesText)).toEqual(['1.0 KB', '1.5 KB', '10 KB', '12 MB', '1.0 MB'])
    expect([10_000_000, 3 * 1024 ** 3, 12.4 * 1024 ** 3, 5000 * 1024 ** 3].map(bytesText)).toEqual(['9.5 MB', '3.0 GB', '12 GB', '5000 GB'])
  })
})
