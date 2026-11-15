import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { groupTasks } from '@cc/core'
import { TaskList } from './TaskList.jsx'

const list = (unreached: { machineId: string; name: string }[]) =>
  renderToStaticMarkup(
    <TaskList groups={groupTasks([])} loaded capped={null} unreached={unreached} cursor={null} doneOpen={false} onToggleDone={() => {}} onOpen={() => {}} />,
  )

// #2268: on a hub, a linked machine whose work could not be read was missing from Tasks without a word
describe('Tasks on a hub, with a linked machine that was not reached', () => {
  it('names each such machine, under "No tasks" too, folding in as a change on screen does, and none when every machine answered', () => {
    const html = list([
      { machineId: 'm1', name: 'Box' },
      { machineId: 'm2', name: 'Laptop' },
    ])
    expect(html).toContain('No tasks')
    expect(html).toContain('data-testid="tasks-unreached"')
    expect(html).toContain('Not listed: the tasks on Box, Laptop, which could not be reached just now.')
    expect(html).toContain('cc-fold')
    // And nothing once every machine answered
    expect(list([])).not.toContain('tasks-unreached')
  })
})
