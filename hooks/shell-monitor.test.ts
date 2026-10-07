import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  component: 'Pane',
  requestId: 'shells',
  props: {
    title: 'Shells',
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

/** The /shells-list listing, as the person reads it. */
async function listing($: Engine) {
  return (await run($, 'shells-list', '')).text ?? ''
}

/** The engine telling the model a background task ended. */
function notify($: Engine, taskId: string, status: string, exitCode: number) {
  const text =
    `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n` +
    `<summary>Background command finished with exit code ${exitCode}</summary>\n</task-notification>`

  // Nothing beneath the plugins stores rows in a test; the mod reads the
  // row before handing it on, so the store's refusal is ignored here.
  return $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text }] } } as never)
    .catch(() => undefined)
}

/**
 * The engine's nouns the mod calls, answered from memory: panes it opens,
 * task output files (`files`, by task id) and a Bash tool that backgrounds
 * every call whose command starts with `bg `.
 */
function world(on: On) {
  const open = new Set<string>()
  const files = new Map<string, string>()
  let tasks = 0

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_$, e) => {
    // The path arrives resolved for this platform: match on the file name.
    const id = e.path.replace(/^.*[\\/]/, '').replace(/\.output$/, '')
    const text = files.get(id)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)

    return { value: text }
  })
  on('ui.open', (_$, e) => {
    open.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    open.delete(e.id)

    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    if (!e.command.startsWith('bg ')) {
      return { result: { stdout: 'quick\n', stderr: '', interrupted: false } }
    }
    tasks += 1
    const id = `task${tasks}`
    files.set(id, '')

    return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id } }
  })

  return { open, files }
}

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: 10_000 })
  mock.env(on, { TEMP: '/tmp' })
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  return { clock, ...w }
}

test('foreground shells are not captured', async ($, on) => {
  const { open } = await start($, on)
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 't1' })

  expect(await listing($)).toBe('No shells yet.')
  expect(open.size).toBe(0)
})

test('a background shell streams, finishes, and stays shown', async ($, on) => {
  const { clock, open, files } = await start($, on)
  await $.tool.call({ tool: 'Bash', command: 'bg npm run build', tool_use_id: 't1' })
  expect([...open]).toEqual(['shells'])

  files.set('task1', 'compiling\n')
  await clock.advance(500)
  const first = await $.ui.mount({ plugin: 'shell-monitor', surface: 'terminal', ...PANE })
  expect(await first.find({ type: 'Text', text: /compiling/ })).toBeDefined()
  await first.unmount()

  files.set('task1', 'compiling\nerror TS2304\n')
  await notify($, 'task1', 'failed', 2)
  expect(await listing($)).toMatch(/#1 +✗ exit 2 .*shown +bg npm run build/)
  expect([...open]).toEqual(['shells'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'shell-monitor', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /error TS2304/ })).toBeDefined()
    await ui.unmount()
  }
})

test('only three windows at once; closing one promotes the queue head', async ($, on) => {
  const { open } = await start($, on)
  for (const n of [1, 2, 3, 4, 5]) {
    await $.tool.call({ tool: 'Bash', command: `bg job ${n}`, tool_use_id: `t${n}` })
  }
  expect([...open]).toEqual(['shells'])
  const before = await listing($)
  for (const n of [1, 2, 3]) expect(before).toMatch(new RegExp(`#${n} .*shown`))
  for (const n of [4, 5]) expect(before).toMatch(new RegExp(`#${n} .*queued`))

  const ui = await $.ui.mount({ plugin: 'shell-monitor', surface: 'terminal', ...PANE })
  for (const n of [1, 2, 3]) expect(await ui.find({ type: 'Text', text: new RegExp(`job ${n}`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 queued/ })).toBeDefined()
  await ui.press({ key: 'close-2' })
  await ui.unmount()

  const after = await listing($)
  for (const n of [1, 3, 4]) expect(after).toMatch(new RegExp(`#${n} .*shown`))
  expect(after).toMatch(/#2 .*hidden/)
  expect(after).toMatch(/#5 .*queued/)

  // Finished shells stay shown until closed; close finished lets #5 in.
  for (const n of [1, 3, 4, 5]) await notify($, `task${n}`, 'completed', 0)
  expect(await listing($)).toMatch(/#4 .*shown/)
  await run($, 'shell-close', 'done')
  expect(await listing($)).toMatch(/#5 .*shown/)
  await run($, 'shell-close', 'done')
  expect(open.size).toBe(0)
})

test('close button closes the window and, with nothing left, the pane', async ($, on) => {
  const { open } = await start($, on)
  await $.tool.call({ tool: 'Bash', command: 'bg serve', tool_use_id: 't1' })

  const ui = await $.ui.mount({ plugin: 'shell-monitor', surface: 'terminal', ...PANE })
  await ui.press({ key: 'close-1' })
  expect(open.size).toBe(0)
  expect(await listing($)).toMatch(/#1 .*hidden/)
})

test('bare /shell shows the running shells, else the newest', async ($, on) => {
  const { open } = await start($, on)
  for (const n of [1, 2, 3]) {
    await $.tool.call({ tool: 'Bash', command: `bg job ${n}`, tool_use_id: `t${n}` })
  }
  await notify($, 'task2', 'completed', 0)
  await run($, 'shell-close', 'all')
  expect(open.size).toBe(0)

  expect((await run($, 'shell', '')).text).toBe('Showing #1, #3.')
  const listed = await listing($)
  expect(listed).toMatch(/#1 .*shown/)
  expect(listed).toMatch(/#2 .*hidden/)
  expect(listed).toMatch(/#3 .*shown/)

  for (const n of [1, 3]) await notify($, `task${n}`, 'completed', 0)
  await run($, 'shell-close', 'all')
  expect((await run($, 'shell', '')).text).toBe('Showing #3.')
})
