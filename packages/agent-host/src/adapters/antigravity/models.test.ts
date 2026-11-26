import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigOption } from '../acp/wire.js'
import { fakeInstall, fakeSignIn, HOST_TEST_ARCHIVE, pathIn, tempData, write } from './agent-files.test-helpers.js'
import { AgySetup } from './setup.js'
import { AGY_BASELINE_MODELS, listAgyModels, saveAgyModels, toModelOptions } from './models.js'

const data: { done(): void }[] = []
afterEach(() => {
  for (const d of data.splice(0)) d.done()
})

const SAMPLE_1_5_OPTIONS: ConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-4-argon',
    options: [
      { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thinking Level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
]

const SAMPLE_1_4_OPTIONS: ConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-3.8-flash',
    options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
  },
  {
    id: 'thinking_level',
    name: 'Thinking Level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
]

describe('toModelOptions', () => {
  it('returns an empty array when model config option is absent', () => {
    expect(toModelOptions([])).toEqual([])
    expect(toModelOptions([{ id: 'thought_level', category: 'thought_level', type: 'select', options: [] }])).toEqual([])
  })

  it('maps Antigravity 1.5.2 configOptions into ModelOption entries', () => {
    const models = toModelOptions(SAMPLE_1_5_OPTIONS)
    expect(models).toHaveLength(5)
    expect(models[0]).toEqual({
      id: 'gemini-4-argon',
      label: 'Gemini 4 Argon',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      tiers: [],
    })
    expect(models[4]).toEqual({
      id: 'gpt-oss-120b-medium',
      label: 'GPT-OSS 120B (Medium)',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      tiers: [],
    })
  })

  it('maps Antigravity 1.4.3 configOptions with thinking_level', () => {
    const models = toModelOptions(SAMPLE_1_4_OPTIONS)
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual({
      id: 'gemini-3.8-flash',
      label: 'Gemini 3.8 Flash',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      tiers: [],
    })
  })

  it('handles options without a thought_level config option', () => {
    const models = toModelOptions([
      {
        id: 'model',
        category: 'model',
        type: 'select',
        options: [{ value: 'model-a' }],
      },
    ])
    expect(models).toEqual([
      {
        id: 'model-a',
        label: 'model-a',
        efforts: [],
        defaultEffort: null,
        tiers: [],
      },
    ])
  })

  it('handles nested option groups in model or thought config', () => {
    const models = toModelOptions([
      {
        id: 'model',
        category: 'model',
        type: 'select',
        options: [{ options: [{ value: 'grouped-model', name: 'Grouped Model' }] }],
      },
      {
        id: 'thought_level',
        category: 'thought_level',
        type: 'select',
        options: [{ options: [{ value: 'low' }, { value: 'high' }] }],
      },
    ])
    expect(models).toEqual([
      {
        id: 'grouped-model',
        label: 'Grouped Model',
        efforts: ['low', 'high'],
        defaultEffort: 'low',
        tiers: [],
      },
    ])
  })
})

describe('listAgyModels and saveAgyModels', () => {
  it('throws toolNotInstalled when archive is null or tool is not installed', async () => {
    const t = tempData()
    data.push(t)
    const setup = new AgySetup({ home: t.home, archive: null, version: '1.4.3', appFound: () => false })
    const signedOut = () => new Error('signed out')
    await expect(listAgyModels(t.home, null, setup, signedOut, 'Antigravity', 'install')).rejects.toThrow('Antigravity is not installed')
  })

  it('throws signedOut when setup is not ready', async () => {
    const t = tempData()
    data.push(t)
    fakeInstall(t.home, HOST_TEST_ARCHIVE)
    const setup = new AgySetup({ home: t.home, archive: HOST_TEST_ARCHIVE, version: '1.4.3', appFound: () => false })
    const signedOut = () => new Error('Antigravity is not signed in')
    await expect(listAgyModels(t.home, HOST_TEST_ARCHIVE, setup, signedOut, 'Antigravity')).rejects.toThrow('Antigravity is not signed in')
  })

  it('returns baseline models when no models.json cache exists', async () => {
    const t = tempData()
    data.push(t)
    fakeInstall(t.home, HOST_TEST_ARCHIVE)
    fakeSignIn(t.home)
    const setup = new AgySetup({ home: t.home, archive: HOST_TEST_ARCHIVE, version: '1.4.3', appFound: () => false })
    const signedOut = () => new Error('signed out')
    const models = await listAgyModels(t.home, HOST_TEST_ARCHIVE, setup, signedOut, 'Antigravity')
    expect(models).toEqual(AGY_BASELINE_MODELS)
  })

  it('returns cached models from models.json when available', async () => {
    const t = tempData()
    data.push(t)
    fakeInstall(t.home, HOST_TEST_ARCHIVE)
    fakeSignIn(t.home)
    const setup = new AgySetup({ home: t.home, archive: HOST_TEST_ARCHIVE, version: '1.4.3', appFound: () => false })
    const customModels = [
      {
        id: 'custom-argon',
        label: 'Custom Argon',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        tiers: [],
      },
    ]
    await saveAgyModels(t.home, customModels)
    const signedOut = () => new Error('signed out')
    const models = await listAgyModels(t.home, HOST_TEST_ARCHIVE, setup, signedOut, 'Antigravity')
    expect(models).toEqual(customModels)
  })

  it('falls back to baseline models when models.json is corrupted', async () => {
    const t = tempData()
    data.push(t)
    fakeInstall(t.home, HOST_TEST_ARCHIVE)
    fakeSignIn(t.home)
    const setup = new AgySetup({ home: t.home, archive: HOST_TEST_ARCHIVE, version: '1.4.3', appFound: () => false })
    write(pathIn(t.home.root, 'models.json'), 'invalid-json')
    const signedOut = () => new Error('signed out')
    const models = await listAgyModels(t.home, HOST_TEST_ARCHIVE, setup, signedOut, 'Antigravity')
    expect(models).toEqual(AGY_BASELINE_MODELS)
  })
})
