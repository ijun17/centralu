import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Badge } from './Badge.jsx'
import { Button, buttonClass } from './Button.jsx'
import { Pill } from './Pill.jsx'
import { Segmented, segmentedTabStop, segmentedTarget } from './Segmented.jsx'
import { TextField, TextInput } from './TextField.jsx'

/** The opening tag of the first element whose attributes match, so a test can read its attributes */
const tag = (html: string, name: string) => new RegExp(`<${name}\\b[^>]*>`).exec(html)?.[0] ?? ''
/** The opening tag of the element a test id names */
const byId = (html: string, id: string) => new RegExp(`<[a-z]+\\s[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? ''
const classes = (html: string, name: string) => (/class="([^"]*)"/.exec(tag(html, name))?.[1] ?? '').split(' ')

describe('Button', () => {
  it('is a framed button of type button, so a press inside a form does not submit it', () => {
    const html = renderToStaticMarkup(<Button>Copy</Button>)
    expect(tag(html, 'button')).toContain('type="button"')
    expect(classes(html, 'button')).toEqual(expect.arrayContaining(['rounded-md', 'border', 'border-line']))
  })

  it('fills only the primary action, and with the floor when it sits on a raised card', () => {
    expect(buttonClass({ variant: 'primary' }).split(' ')).toContain('bg-surface-raised')
    expect(buttonClass({ variant: 'primary', onRaised: true }).split(' ')).toContain('bg-surface-floor')
    expect(buttonClass({ variant: 'primary', onRaised: true }).split(' ')).not.toContain('bg-surface-raised')
    for (const variant of ['secondary', 'quiet', 'subtle', 'ghost'] as const) {
      expect(buttonClass({ variant }).split(' ').filter((c) => c.startsWith('bg-'))).toEqual([])
    }
  })

  it('wears the danger colour only as danger, and no frame as ghost', () => {
    expect(buttonClass({ variant: 'danger' })).toContain('text-danger')
    for (const variant of ['primary', 'secondary', 'quiet', 'subtle', 'ghost'] as const) expect(buttonClass({ variant })).not.toContain('danger')
    expect(buttonClass({ variant: 'ghost' }).split(' ')).not.toContain('border')
  })

  it('keeps a control in a line of reading in the faint ink, and a quiet one a step brighter', () => {
    expect(buttonClass({ variant: 'subtle' }).split(' ')).toContain('text-ink-faint')
    expect(buttonClass({ variant: 'quiet' }).split(' ')).toContain('text-ink-muted')
  })

  it('has one padding and one text size per size', () => {
    const pad = (s: 'xs' | 'sm' | 'md') => buttonClass({ size: s }).split(' ').filter((c) => /^(px|py|text-(2xs|xs|sm|md))-?/.test(c) && !c.startsWith('text-ink'))
    expect(pad('md')).toEqual(['px-3', 'py-1', 'text-sm'])
    expect(pad('sm')).toEqual(['px-2', 'py-0.5', 'text-xs'])
    expect(pad('xs')).toEqual(['px-1.5', 'text-2xs'])
  })

  it('reacts to hover only while it can be pressed', () => {
    for (const variant of ['primary', 'secondary', 'quiet', 'subtle', 'danger', 'ghost'] as const) {
      const hovers = buttonClass({ variant }).split(' ').filter((c) => c.includes('hover:'))
      expect(hovers.length).toBeGreaterThan(0)
      expect(hovers.every((c) => c.startsWith('enabled:hover:'))).toBe(true)
    }
  })

  it('fades to half when disabled, as every shared control does', () => {
    for (const variant of ['primary', 'secondary', 'quiet', 'subtle', 'danger', 'ghost'] as const) {
      const fades = buttonClass({ variant }).split(' ').filter((c) => c.includes('opacity-'))
      expect(fades).toEqual(['disabled:opacity-50'])
    }
  })

  it('while busy is disabled and says what it is doing', () => {
    const html = renderToStaticMarkup(
      <Button busy busyText="Creating…">
        Create
      </Button>,
    )
    expect(tag(html, 'button')).toContain('disabled=""')
    expect(tag(html, 'button')).toContain('aria-busy="true"')
    expect(html).toContain('Creating…')
    expect(html).not.toContain('>Create<')
  })

  it('keeps its label while busy when no busy text is given', () => {
    const html = renderToStaticMarkup(<Button busy>Save</Button>)
    expect(html).toContain('>Save<')
    expect(tag(html, 'button')).toContain('disabled=""')
  })

  it('passes through what a call site names it by, and puts placement after the look', () => {
    const html = renderToStaticMarkup(
      <Button data-testid="go" type="submit" className="mt-3 shrink-0" title="Go">
        Go
      </Button>,
    )
    expect(tag(html, 'button')).toContain('data-testid="go"')
    expect(tag(html, 'button')).toContain('type="submit"')
    expect(classes(html, 'button').slice(-2)).toEqual(['mt-3', 'shrink-0'])
  })
})

describe('Segmented', () => {
  const options = [
    { value: 'dark', label: 'Dark', testId: 'mode-dark' },
    { value: 'light', label: 'Light', testId: 'mode-light' },
    { value: 'system', label: 'System', testId: 'mode-system' },
  ] as const

  it('is a named radio group whose picked option says so', () => {
    const html = renderToStaticMarkup(<Segmented label="Theme mode" value="light" options={options} onChange={() => {}} />)
    expect(tag(html, 'div')).toContain('role="radiogroup"')
    expect(tag(html, 'div')).toContain('aria-label="Theme mode"')
    expect(html.match(/role="radio"/g)).toHaveLength(3)
    expect(byId(html, 'mode-light')).toContain('aria-checked="true"')
    expect(byId(html, 'mode-dark')).toContain('aria-checked="false"')
  })

  it('takes Tab on the picked option only, so Tab leaves the group in one press', () => {
    const html = renderToStaticMarkup(<Segmented label="Mode" value="light" options={options} onChange={() => {}} />)
    expect(byId(html, 'mode-light')).toContain('tabindex="0"')
    expect(byId(html, 'mode-dark')).toContain('tabindex="-1"')
    expect(byId(html, 'mode-system')).toContain('tabindex="-1"')
  })

  it('with nothing picked, Tab lands on the first option that can be picked', () => {
    expect(segmentedTabStop(['a', 'b', 'c'], [false, false, false], null)).toBe(0)
    expect(segmentedTabStop(['a', 'b', 'c'], [true, false, false], 'z')).toBe(1)
    expect(segmentedTabStop(['a', 'b', 'c'], [true, false, false], 'c')).toBe(2)
  })

  it('moves with the arrows both ways, wrapping at the ends', () => {
    const none = [false, false, false]
    expect(segmentedTarget(none, 0, 'ArrowRight')).toBe(1)
    expect(segmentedTarget(none, 0, 'ArrowDown')).toBe(1)
    expect(segmentedTarget(none, 2, 'ArrowRight')).toBe(0)
    expect(segmentedTarget(none, 0, 'ArrowLeft')).toBe(2)
    expect(segmentedTarget(none, 1, 'ArrowUp')).toBe(0)
  })

  it('jumps to the ends with Home and End, and ignores every other key', () => {
    const none = [false, false, false, false]
    expect(segmentedTarget(none, 2, 'Home')).toBe(0)
    expect(segmentedTarget(none, 1, 'End')).toBe(3)
    expect(segmentedTarget(none, 0, 'Home')).toBeNull()
    for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape']) expect(segmentedTarget(none, 1, key)).toBeNull()
  })

  it('skips an option that cannot be picked, and stays put when nothing else can be', () => {
    expect(segmentedTarget([false, true, false], 0, 'ArrowRight')).toBe(2)
    expect(segmentedTarget([false, true, false], 2, 'ArrowRight')).toBe(0)
    expect(segmentedTarget([true, false, true], 1, 'ArrowRight')).toBeNull()
    expect(segmentedTarget([true, false, true, false], 3, 'Home')).toBe(1)
    expect(segmentedTarget([false, true, false, true], 0, 'End')).toBe(2)
  })

  it('draws the picked option lifted and the others framed, a disabled one unpickable and a dim one faded', () => {
    const html = renderToStaticMarkup(
      <Segmented
        label="Tool"
        value="a"
        onChange={() => {}}
        options={[
          { value: 'a', label: 'A', testId: 'a' },
          { value: 'b', label: 'B', testId: 'b', disabled: true },
          { value: 'c', label: 'C', testId: 'c', dim: true },
        ]}
      />,
    )
    const cls = (id: string) => (/class="([^"]*)"/.exec(byId(html, id))?.[1] ?? '').split(' ')
    expect(cls('a')).toEqual(expect.arrayContaining(['border-ink-muted', 'bg-surface-hover/40', 'text-ink']))
    expect(cls('c')).toEqual(expect.arrayContaining(['border-line', 'text-ink-muted', 'opacity-50']))
    expect(byId(html, 'b')).toContain('disabled=""')
    expect(cls('b')).toContain('disabled:opacity-50')
    expect(cls('a')).not.toContain('opacity-50')
  })
})

describe('Pill', () => {
  it('is a button when it does something and a span when it only reports', () => {
    expect(renderToStaticMarkup(<Pill onClick={() => {}}>Update</Pill>)).toMatch(/^<button type="button"/)
    expect(renderToStaticMarkup(<Pill>Updating…</Pill>)).toMatch(/^<span/)
  })

  it('is the rounded capsule of the top bar, or the small kind label of a card', () => {
    const bar = classes(renderToStaticMarkup(<Pill>x</Pill>), 'span')
    expect(bar).toEqual(expect.arrayContaining(['rounded-full', 'border', 'h-7', 'px-2.5', 'bg-surface-hover/30']))
    const label = classes(renderToStaticMarkup(<Pill size="label" edge="solid" tone="bright">Agent is asking</Pill>), 'span')
    expect(label).toEqual(expect.arrayContaining(['rounded-full', 'border', 'px-2', 'py-px', 'text-2xs', 'border-ink-signal', 'text-ink-signal']))
    // A label has no fill and no bar height
    expect(label.filter((c) => c.startsWith('bg-') || c.startsWith('h-'))).toEqual([])
  })

  it('says with its edge what kind of thing it carries', () => {
    const edge = (e: 'quiet' | 'live' | 'solid' | 'dashed') => classes(renderToStaticMarkup(<Pill edge={e}>x</Pill>), 'span')
    expect(edge('quiet')).toEqual(expect.arrayContaining(['border-solid', 'border-line']))
    expect(edge('live')).toEqual(expect.arrayContaining(['border-solid', 'border-line-strong']))
    expect(edge('solid')).toEqual(expect.arrayContaining(['border-solid', 'border-ink-signal']))
    expect(edge('dashed')).toEqual(expect.arrayContaining(['border-dashed', 'border-ink-signal', 'text-ink-signal']))
    // What waits on the person is the signal ink at full strength: no fraction of it, and not the plain ink
    for (const e of ['solid', 'dashed'] as const) {
      expect(edge(e).filter((c) => c.startsWith('border-ink'))).toEqual(['border-ink-signal'])
    }
  })

  it('brightens on hover only when it can be pressed', () => {
    expect(renderToStaticMarkup(<Pill>x</Pill>)).not.toContain('hover:')
    expect(renderToStaticMarkup(<Pill onClick={() => {}}>x</Pill>)).toContain('hover:bg-surface-hover/60')
  })

  it('takes a tone over its edge, keeping the waiting glow for the signal', () => {
    const cls = classes(renderToStaticMarkup(<Pill tone="signal">3</Pill>), 'span')
    expect(cls).toContain('signal')
    expect(cls).not.toContain('[text-shadow:none]')
    expect(cls).not.toContain('text-ink-muted')
  })
})

describe('Badge', () => {
  it('is small faint capitals', () => {
    expect(classes(renderToStaticMarkup(<Badge>Runs</Badge>), 'span')).toEqual(['text-2xs', 'uppercase', 'text-ink-faint'])
  })

  it('takes the figures font, a brighter ink and the element of its document when asked', () => {
    const html = renderToStaticMarkup(
      <Badge as="h3" readout tone="ink" data-testid="b">
        Alert
      </Badge>,
    )
    expect(html).toMatch(/^<h3 class="readout text-2xs uppercase text-ink" data-testid="b">Alert<\/h3>$/)
  })
})

describe('TextField', () => {
  it('draws the framed input of the forms', () => {
    const cls = classes(renderToStaticMarkup(<TextInput />), 'input')
    expect(cls).toEqual(
      expect.arrayContaining(['rounded-md', 'border', 'border-line', 'bg-surface-floor', 'px-2', 'py-1.5', 'text-xs', 'text-ink', 'focus:border-line-strong']),
    )
  })

  it('has one padding per size, and the raised fill for a panel that is the floor already', () => {
    const pad = (size: 'xs' | 'sm' | 'md') => classes(renderToStaticMarkup(<TextInput size={size} />), 'input').filter((c) => /^p[xy]-/.test(c))
    expect(pad('md')).toEqual(['px-2', 'py-1.5'])
    expect(pad('sm')).toEqual(['px-2', 'py-1'])
    expect(pad('xs')).toEqual(['px-1.5', 'py-0.5'])
    const raised = classes(renderToStaticMarkup(<TextInput surface="raised" />), 'input')
    expect(raised).toContain('bg-surface-raised')
    expect(raised).not.toContain('bg-surface-floor')
    const side = classes(renderToStaticMarkup(<TextInput surface="side" />), 'input')
    expect(side.filter((c) => c.startsWith('bg-'))).toEqual(['bg-surface-side'])
  })

  it('when invalid wears the danger frame and says so', () => {
    const html = renderToStaticMarkup(<TextInput invalid />)
    expect(classes(html, 'input')).toContain('border-danger')
    expect(classes(html, 'input')).not.toContain('border-line')
    expect(tag(html, 'input')).toContain('aria-invalid="true"')
  })

  it('puts the input under its label and hint, inside the label so a press on the name focuses it', () => {
    const html = renderToStaticMarkup(<TextField label="Branch" hint="blank = automatic" data-testid="f" />)
    expect(html).toMatch(/^<label class="block"><span[^>]*>Branch<span class="text-ink-faint"> · blank = automatic<\/span><\/span><input/)
    expect(tag(html, 'input')).toContain('data-testid="f"')
    expect(tag(html, 'input')).not.toContain('aria-invalid')
  })

  it('says the problem under the field and ties it to the input', () => {
    const html = renderToStaticMarkup(<TextField label="Id" error="Pick another." errorTestId="id-problem" />)
    const describedBy = /aria-describedby="([^"]+)"/.exec(tag(html, 'input'))?.[1]
    expect(describedBy).toBeTruthy()
    expect(html).toContain(`id="${describedBy}"`)
    expect(html).toContain('data-testid="id-problem"')
    expect(tag(html, 'input')).toContain('aria-invalid="true"')
    // A problem shown while typing is a hint: the frame stays the hairline unless the field is `invalid`
    expect(classes(html, 'input')).toContain('border-line')
  })
})
