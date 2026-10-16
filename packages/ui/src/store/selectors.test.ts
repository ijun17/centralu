import { describe, expect, it } from 'vitest'
import { projectLabelOf } from './selectors.js'

describe('projectLabelOf', () => {
  const projects = { p1: { name: 'alpha' } }

  it('is the project name', () => {
    expect(projectLabelOf(projects, 'p1')).toBe('alpha')
  })

  it('names the orchestrator, which has no project', () => {
    expect(projectLabelOf(projects, null)).toBe('Orchestrator')
  })

  it('says nothing for a project the list does not hold yet', () => {
    expect(projectLabelOf(projects, 'gone')).toBe('')
  })
})
