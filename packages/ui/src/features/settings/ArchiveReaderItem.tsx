import type { ChatItem } from '../../store/store.js'
import { Markdown } from '../session/Markdown.jsx'

/**
 * One item of a conversation read in the session archive (#204), drawn plainly: the words, the tool calls by name, the
 * boundaries. A archived session's and a kept app-agent run's (#378) are read the same way.
 */
export function ReaderItem({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <li className="rounded-md bg-surface-raised px-2.5 py-1.5 text-sm whitespace-pre-wrap text-ink">
          {item.from && <span className="mr-1.5 text-2xs text-ink-faint">from {item.from.name}</span>}
          {item.text}
          {item.attachments?.length ? (
            <span className="ml-1.5 text-2xs text-ink-faint">
              +{item.attachments.length} {item.attachments.length === 1 ? 'attachment' : 'attachments'}
            </span>
          ) : null}
        </li>
      )
    case 'assistant':
      return (
        <li className="text-sm">
          <Markdown text={item.text} projectRoot={null} />
        </li>
      )
    case 'tool':
      return <li className="font-mono text-2xs text-ink-faint">▸ {item.title || item.tool}</li>
    case 'approval':
      return (
        <li className="text-2xs text-ink-faint">
          Approval · {item.summary}
          {item.decision ? ` — ${item.decision}` : ''}
        </li>
      )
    case 'mark':
      return <li className="border-t border-line/60 pt-1 text-center text-2xs text-ink-faint">{item.text}</li>
    case 'image':
      return <li className="text-2xs text-ink-faint">[image]</li>
    case 'reasoning':
      return null
  }
}

