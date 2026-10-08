import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const PANE = {
  component: 'Pane',
  requestId: 'agents',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { bodyRows: 30, contentRows: 30, top: 0 },
    view: {},
  } as never,
} as const

/** Runs a slash command as the person typing it would. */
function run($: Engine, command: string, args: string) {
  return $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  } as never)
}

/** The /agents-list listing, as the person reads it. */
async function listing($: Engine) {
  return (await run($, 'agents-list', '')).text ?? ''
}

/** A row of agent `agentId`'s conversation reaching the transcript. */
function append($: Engine, agentId: string | undefined, message: Record<string, unknown>) {
  // Nothing beneath the plugins stores rows in a test; the mod reads the
  // row before handing it on, so the store's refusal is ignored here.
  return $.session
    .append({ message: { role: message.type, ...message }, ...(agentId ? { agentId } : {}) } as never)
    .catch(() => undefined)
}

/**
 * The engine's nouns the mod calls, answered from memory: panes it opens, an
 * agent.spawn that starts `agent-N` (a teammate when the prompt says so) and
 * an agent list whose statuses the test sets in `statuses`.
 */
function world(on: On) {
  const open = new Set<string>()
  const statuses = new Map<string, AgentInfo['status']>()
  let spawned = 0

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', (_$, e) => {
    open.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    open.delete(e.id)

    return { value: undefined }
  })
  on('agent.spawn', (_$, e) => {
    spawned += 1
    const agentId = `agent-${spawned}`
    statuses.set(agentId, 'running')

    return e.prompt === 'team'
      ? { model: 'm', agentId, teammateId: `mate@team` }
      : { model: 'm', agentId }
  })
  on('agent.list', () => ({
    value: [...statuses].map(([id, status]) => ({ id, status, description: id, type: 'general-purpose' })),
  }))

  return { open, statuses }
}

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: 10_000 })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  return { clock, ...w }
}

function spawn($: Engine, description: string, extra: Record<string, unknown> = {}) {
  return $.agent.spawn({ prompt: 'go', description, subagentType: 'general-purpose', ...extra } as never)
}

const said = (text: string) => ({ type: 'assistant', content: [{ type: 'text', text }] })

test('a spawn opens the pane; a fourth agent is queued', async ($, on) => {
  const { open } = await start($, on)
  for (const n of [1, 2, 3, 4]) await spawn($, `task ${n}`)
  expect([...open]).toEqual(['agents'])

  const listed = await listing($)
  for (const n of [1, 2, 3]) expect(listed).toMatch(new RegExp(`#${n} +● running .*shown .*task ${n}`))
  expect(listed).toMatch(/#4 .*queued/)

  const ui = await $.ui.mount({ plugin: 'agent-monitor', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /starting…/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 queued/ })).toBeDefined()
  await ui.unmount()
})

test('text shows in full, tool calls group, thinking never shows', async ($, on) => {
  await start($, on)
  await spawn($, 'build it')
  await append($, 'agent-1', { type: 'user', content: [{ type: 'text', text: 'THE PROMPT' }] })
  await append($, 'agent-1', {
    type: 'assistant',
    content: [
      { type: 'thinking', thinking: 'SECRET THOUGHTS' },
      { type: 'text', text: 'Checking the build now.' },
      { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'pwd' } },
    ],
  })
  await append($, 'agent-1', {
    type: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'u1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'u2', content: 'ok' },
    ],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-monitor', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /Checking the build now\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⎿ Ran 2 shell commands/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● running · 2 tool uses/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /SECRET/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /THE PROMPT/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a failed tool result marks its group', async ($, on) => {
  await start($, on)
  await spawn($, 'read things')
  await append($, 'agent-1', {
    type: 'assistant',
    content: [
      { type: 'tool_use', id: 'u1', name: 'Read', input: {} },
      { type: 'text', text: 'Now searching.' },
      { type: 'tool_use', id: 'u2', name: 'Grep', input: {} },
    ],
  })
  await append($, 'agent-1', {
    type: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'missing', is_error: true }],
  })

  const ui = await $.ui.mount({ plugin: 'agent-monitor', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /✗ Read 1 file/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⎿ Searched 1 time/ })).toBeDefined()
  await ui.unmount()
})

test('rows of the main loop, untracked agents and meta rows are ignored', async ($, on) => {
  await start($, on)
  await spawn($, 'quiet')
  await append($, undefined, said('MAIN LOOP'))
  await append($, 'agent-99', said('STRANGER'))
  await append($, 'agent-1', { type: 'user', isMeta: true, content: [{ type: 'text', text: 'META' }] })
  await append($, 'agent-1', { type: 'attachment', content: [{ type: 'text', text: 'ATTACHED' }] })

  const ui = await $.ui.mount({ plugin: 'agent-monitor', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /starting…/ })).toBeDefined()
  for (const text of [/MAIN LOOP/, /STRANGER/, /META/, /ATTACHED/]) {
    expect(await ui.find({ type: 'Text', text })).toBeUndefined()
  }
  await ui.unmount()
})

test('status follows the agent list: waiting, then done with its time', async ($, on) => {
  const { clock, statuses } = await start($, on)
  await spawn($, 'long job')

  statuses.set('agent-1', 'waiting')
  await clock.advance(1000)
  expect(await listing($)).toMatch(/#1 +◐ waiting/)

  await clock.advance(70_000)
  statuses.set('agent-1', 'completed')
  await clock.advance(1000)
  expect(await listing($)).toMatch(/#1 +✓ done +1m 12s/)

  // Ended, the time stops.
  await clock.advance(30_000)
  expect(await listing($)).toMatch(/#1 +✓ done +1m 12s/)
})

test('turn.complete settles the status without waiting for the poll', async ($, on) => {
  const { statuses } = await start($, on)
  await spawn($, 'quick')
  statuses.set('agent-1', 'failed')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 'agent-1', reason: 'completed' } as never)

  expect(await listing($)).toMatch(/#1 +✗ failed/)
})

test('a foreground agent that left the list has ended, as its turn said', async ($, on) => {
  const { statuses } = await start($, on)
  for (const n of [1, 2]) await spawn($, `fg ${n}`)
  for (const id of ['agent-1', 'agent-2']) statuses.delete(id)
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', agentId: 'agent-1', reason: 'answer' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't', agentId: 'agent-2', reason: 'aborted' } as never)

  const listed = await listing($)
  expect(listed).toMatch(/#1 +✓ done/)
  expect(listed).toMatch(/#2 +■ killed/)
})

test('a nested agent gets its own window, naming its parent', async ($, on) => {
  await start($, on)
  await spawn($, 'outer')
  await spawn($, 'inner', { parentAgentId: 'agent-1' })

  expect(await listing($)).toMatch(/#2 .*\[from #1\] +inner/)
  const ui = await $.ui.mount({ plugin: 'agent-monitor', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /from #1/ })).toBeDefined()
  await ui.unmount()
})

test('a teammate is not tracked', async ($, on) => {
  const { open } = await start($, on)
  await $.agent.spawn({ prompt: 'team', description: 'mate', subagentType: 'teammate' } as never)

  expect(await listing($)).toBe('No agents yet.')
  expect(open.size).toBe(0)
})

test('close finished, clear, and bring windows back', async ($, on) => {
  const { clock, open, statuses } = await start($, on)
  for (const n of [1, 2, 3]) await spawn($, `job ${n}`)
  statuses.set('agent-2', 'completed')
  await clock.advance(1000)

  expect((await run($, 'agent-close', 'done')).text).toBe('Closed 1 agent pane.')
  expect(await listing($)).toMatch(/#2 .*hidden/)

  expect((await run($, 'agent-clear', '')).text).toBe('Forgot 1 finished agent.')
  expect(await listing($)).not.toMatch(/#2/)

  await run($, 'agent-close', 'all')
  expect(open.size).toBe(0)
  expect((await run($, 'agent', '')).text).toBe('Showing #1, #3.')
  expect([...open]).toEqual(['agents'])
  expect((await run($, 'agent', '7')).text).toBe('No agent #7. /agents-list lists them.')
})

/** The person's wheel over the Agents pane body, at `row`. */
function wheel($: Engine, by: number, row?: number) {
  return $.ui.scroll({
    component: 'Pane',
    requestId: 'agents',
    offset: 0,
    by,
    bodyRows: 30,
    contentRows: 30,
    origin: { kind: 'person' },
    ...(row === undefined ? {} : { pointer: { column: 5, row } }),
  } as never)
}

test('each window scrolls on its own and follows the end again at the bottom', async ($, on) => {
  await start($, on)
  for (const n of [1, 2]) await spawn($, `job ${n}`)
  const many = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
  for (const id of ['agent-1', 'agent-2']) await append($, id, said(many))

  // 30 rows, 2 windows: 14 rows each, 10 rows of steps shown.
  const ui = await $.ui.mount({ plugin: 'agent-monitor', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^line 50$/ })).toBeDefined()

  // Wheel up 5 over the first window (rows 0-13) only.
  await wheel($, -5, 3)
  expect(await ui.find({ type: 'Text', text: /↓5/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /^line 45$/ })).toHaveLength(2)
  expect(await ui.findAll({ type: 'Text', text: /^line 50$/ })).toHaveLength(1)
  expect(await ui.find({ key: 'end-1' })).toBeDefined()
  expect(await ui.find({ key: 'end-2' })).toBeUndefined()

  // Scrolled up, the window stays put as steps arrive (a blank row, then the text).
  await append($, 'agent-1', said('line 51'))
  expect(await ui.find({ type: 'Text', text: /↓7/ })).toBeDefined()

  // Keys (no pointer) go to the window the wheel last moved; past the top clamps.
  await wheel($, -100)
  expect(await ui.find({ type: 'Text', text: /^line 1$/ })).toBeDefined()

  // [ end ] returns to following.
  await ui.press({ key: 'end-1' })
  expect(await ui.find({ key: 'end-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^line 51$/ })).toBeDefined()
  await ui.unmount()
})

test('the run time ticks while the agent runs and stops when it ends', async ($, on) => {
  const { clock, statuses } = await start($, on)
  await spawn($, 'ticking')

  const ui = await $.ui.mount({ plugin: 'agent-monitor', surface: 'terminal', ...PANE })
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /· 5s$/ })).toBeDefined()

  statuses.set('agent-1', 'completed')
  await clock.advance(1000)
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /· 6s$/ })).toBeDefined()
  await ui.unmount()
})

test('long text wraps to the window width', async ($, on) => {
  await start($, on)
  await spawn($, 'wordy')
  await append($, 'agent-1', said(`${'a'.repeat(58)}TAIL`))

  const ui = await $.ui.mount({ plugin: 'agent-monitor', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^a{58}$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^TAIL$/ })).toBeDefined()
  await ui.unmount()
})
