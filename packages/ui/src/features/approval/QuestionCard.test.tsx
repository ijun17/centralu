import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Question } from '@cc/protocol'
import { QuestionCard, answersOnPick } from './QuestionCard.jsx'

const q = (over: Partial<Question> = {}): Question => ({
  question: 'Which copy?',
  header: 'Copy',
  options: [
    { label: 'Short', description: 'A line' },
    { label: 'Long', description: 'A paragraph' },
  ],
  multiSelect: false,
  ...over,
})

describe('answersOnPick', () => {
  it('answers on the click for one question with one choice', () => {
    expect(answersOnPick([q()])).toBe(true)
  })

  it('keeps the Answer button for a multiple-choice question', () => {
    expect(answersOnPick([q({ multiSelect: true })])).toBe(false)
  })

  it('keeps the Answer button when there are several questions, since all must be answered', () => {
    expect(answersOnPick([q(), q({ question: 'And the colour?' })])).toBe(false)
  })
})

describe('QuestionCard', () => {
  const render = (questions: Question[]) =>
    renderToStaticMarkup(<QuestionCard sessionId="s1" requestId="r1" questions={questions} />)

  it('tells a single-choice question that a click answers, and keeps "Other" and Answer', () => {
    const html = render([q()])
    expect(html).toContain('Click an option to answer, or write your own')
    expect(html).toContain('data-testid="question-other"')
    expect(html).toContain('data-testid="question-submit"')
  })

  it('keeps the old hint where a click does not answer', () => {
    expect(render([q({ multiSelect: true })])).toContain('Choose an option')
    expect(render([q(), q()])).not.toContain('Click an option to answer')
  })
})
