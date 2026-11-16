/*
 * The words a message's `origin` takes (docs/plans/mailbox.md §3.3): what opened the exchange it began, which names how a
 * delegation is recorded. They are what is left of the thread world mail had before the message tables (store step v61);
 * its rows were moved by store step v75.
 */

/** What opened a thread (§3.3) */
export const THREAD_ORIGINS = ['mail', 'start_agent', 'agent_session', 'send_to_session', 'create_session', 'ask_project', 'app', 'watch', 'person'] as const
export type ThreadOrigin = (typeof THREAD_ORIGINS)[number]

/** The origins a session's delegation tools open threads with (§8.1): work one session gave another, written down by the host */
export const DELEGATION_ORIGINS = ['start_agent', 'agent_session', 'send_to_session', 'create_session', 'ask_project'] as const satisfies readonly ThreadOrigin[]

/**
 * The delegation tools that send to a session already there, which may be busy: their send waits as a task from the sender (an earlier build's
 * queued request too), shown in the receiver's conversation as the sender's message, as their direct send is (#1948 step 2, option B)
 */
export const SEND_ORIGINS: ReadonlySet<string> = new Set<ThreadOrigin>(['agent_session', 'ask_project', 'send_to_session'])
