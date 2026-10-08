import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Shell, ShellStatus } from '../types'

const MAX_PANES = 3
const POLL_MS = 400
const OUTPUT_CAP = 200_000
// One pane holding up to MAX_PANES stacked shell windows: the engine shows
// several panes as tabs, so the stacking is drawn inside a single pane.
const PANE_ID = 'shells'

const shellsAtom = atom({ plugin: 'shell-monitor', key: 'shells' } as const, [])
const slotsAtom = atom({ plugin: 'shell-monitor', key: 'slots' } as const, [])
const queueAtom = atom({ plugin: 'shell-monitor', key: 'queue' } as const, [])
const nextNAtom = atom({ plugin: 'shell-monitor', key: 'nextN' } as const, 1)
const tasksDirAtom = atom({ plugin: 'shell-monitor', key: 'tasksDir' } as const, '')
// Per window, the first line shown while scrolled up; absent means follow the end.
const scrollAtom = atom({ plugin: 'shell-monitor', key: 'scroll' } as const, {})
// The second the windows' run times count to; the poll moves it while any shell runs.
const nowAtom = atom({ plugin: 'shell-monitor', key: 'now' } as const, 0)

type $ = EngineInterface

const glyph: Record<ShellStatus, string> = {
  running: '●',
  done: '✓',
  failed: '✗',
  killed: '■',
}

const statusLabel = (shell: Shell) =>
  shell.status === 'running'
    ? `${glyph.running} running`
    : shell.exitCode !== undefined
      ? `${glyph[shell.status]} exit ${shell.exitCode}`
      : `${glyph[shell.status]} ${shell.status}`

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

const label = (shell: Shell) =>
  clip((shell.description || shell.command).replace(/\s+/g, ' ').trim(), 40)

const stripAnsi = (text: string) =>
  text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

const capTail = (text: string) =>
  text.length <= OUTPUT_CAP ? text : text.slice(text.length - OUTPUT_CAP)

/** The output as the window draws it: one entry per terminal line, trailing blanks dropped. */
const linesOf = (text: string) => {
  const lines = stripAnsi(text).replace(/\r\n/g, '\n').split('\n')
    .map(line => line.slice(line.lastIndexOf('\r') + 1))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return lines
}

/** Equal window heights: the footer row takes 1, each window splits the rest. */
const layout = (total: number, count: number) => {
  const height = Math.max(6, Math.floor((total - 1) / count))

  // Border 2 + header 1 + command 1 + the status line under the output 1.
  return { height, room: Math.max(1, height - 5) }
}

/** The first line a window shows, its saved place clamped to the output. */
const topOf = (saved: number | undefined, length: number, room: number) => {
  const last = Math.max(0, length - room)

  return saved === undefined ? last : Math.min(Math.max(0, saved), last)
}

const slugOf = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

const exitCodeIn = (text: string | undefined) => {
  const match = text?.match(/exit code[:\s]+(-?\d+)/i)

  return match ? Number(match[1]) : undefined
}

function setOutput($: $, n: number, text: string) {
  return $.state.set({ plugin: 'shell-monitor', key: 'output', id: String(n) }, capTail(text))
}

function patchShell($: $, n: number, patch: Partial<Shell>) {
  return update($, shellsAtom, list => list.map(one => (one.n === n ? { ...one, ...patch } : one)))
}

// Module-local bookkeeping; lost on reload, which the poll tolerates.
const lastLength = new Map<number, number>()
let isTicking = false
// The run times the windows last drew, so the poll redraws only when one changes.
let lastShown = ''
// The window the wheel last moved: where the scroll keys go.
let lastScrolled: number | undefined

const readOutput = async ($: $, n: number) =>
  (await $.state.get({ plugin: 'shell-monitor', key: 'output', id: String(n) })).value ?? ''

/** Saves window n's first line; at the end it follows new output again. */
function setTop($: $, n: number, top: number | undefined) {
  return update($, scrollAtom, map => {
    const { [String(n)]: _, ...rest } = map

    return top === undefined ? rest : { ...rest, [String(n)]: top }
  })
}

async function openPane($: $, n: number, isAsked: boolean) {
  const opened = await $.ui.open({ id: PANE_ID, title: 'Shells' })
  if (!opened.isPlaced && !isAsked) {
    $.ui.toast(`shell #${n} waiting: widen the terminal or run /shell ${n}`)
  }
}

async function promote($: $, isAsked: boolean) {
  for (;;) {
    const n = (await read($, queueAtom))[0]
    if (n === undefined) return
    // Seat inside update() so concurrent promotes never exceed MAX_PANES.
    let isSeated = false
    await update($, slotsAtom, list => {
      isSeated = list.includes(n) || list.length < MAX_PANES

      return isSeated && !list.includes(n) ? [...list, n] : list
    })
    if (!isSeated) return
    await update($, queueAtom, list => list.filter(one => one !== n))
    await openPane($, n, isAsked)
  }
}

/** Shows shell n: a free slot now, else the queue (its head when asked). */
async function offer($: $, n: number, isAsked: boolean) {
  const slots = await read($, slotsAtom)
  if (slots.includes(n)) return
  await update($, queueAtom, list => {
    const rest = list.filter(one => one !== n)

    return isAsked ? [n, ...rest] : [...rest, n]
  })
  await promote($, isAsked)
}

/** Takes shell n out of its pane or the queue and fills the freed slot. */
async function release($: $, n: number, isPaneGone = false) {
  await update($, slotsAtom, list => list.filter(one => one !== n))
  await update($, queueAtom, list => list.filter(one => one !== n))
  await setTop($, n, undefined)
  await promote($, true)
  if (!isPaneGone && (await read($, slotsAtom)).length === 0) await $.ui.close({ id: PANE_ID })
}

async function finish($: $, n: number, patch: Partial<Shell>) {
  await patchShell($, n, { ...patch, isFinal: true, endedAt: await $.clock.now() })
  await refreshStatus($)
}

async function refreshStatus($: $) {
  const running = (await read($, shellsAtom)).filter(one => one.status === 'running').length
  $.ui.status(running > 0 ? `shells: ${running} running` : undefined)
}

async function tick($: $) {
  if (isTicking) return
  isTicking = true
  try {
    const live = (await read($, shellsAtom)).filter(one => !one.isFinal)
    if (live.length === 0) return
    // Writing the time redraws the pane: do it when a running shell's shown seconds change.
    const now = await $.clock.now()
    const shown = live.map(one => elapsed(now - one.startedAt)).join()
    if (shown !== lastShown) {
      lastShown = shown
      await update($, nowAtom, () => now)
    }
    const dir = await read($, tasksDirAtom)
    if (!dir) return

    for (const shell of live) {
      const text = await $.fs.read(`${dir}/${shell.taskId}.output`).catch(() => undefined)
      if (text !== undefined && text.length !== lastLength.get(shell.n)) {
        lastLength.set(shell.n, text.length)
        await setOutput($, shell.n, text)
      }
    }
  } finally {
    isTicking = false
  }
}

/** Closes matching shown windows; with `isQueueToo`, drops matching queued ones as well. */
async function closeWhere($: $, pick: (shell: Shell) => boolean, isQueueToo = false) {
  const shells = await read($, shellsAtom)
  const slots = await read($, slotsAtom)
  const queue = await read($, queueAtom)
  const targets = shells.filter(
    one => pick(one) && (slots.includes(one.n) || (isQueueToo && queue.includes(one.n))),
  )
  for (const shell of targets) await release($, shell.n)

  return targets.length
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const spec of [
      { name: 'shells-list', description: 'List the background shells Claude started this session' },
      { name: 'shell', description: 'Show a shell in a pane; with no number, every running one (else the newest)', argumentHint: '[n]' },
      { name: 'shell-close', description: 'Close shell panes', argumentHint: '<n|done|all>' },
      { name: 'shell-clear', description: 'Forget finished shells' },
    ]) {
      await $.command.register({ ...spec, immediate: true })
    }

    const base =
      (await $.env.get('CLAUDE_CODE_TMPDIR')) ??
      (await $.env.get('TEMP')) ??
      (await $.env.get('TMP')) ??
      (await $.env.get('TMPDIR')) ??
      '/tmp'
    const dir = `${base.replace(/[\\/]+$/, '')}/claude/${slugOf(e.cwd)}/${await $.session.id()}/tasks`
    await update($, tasksDirAtom, () => dir)

    $.clock.every(POLL_MS, () => void tick($))

    // Earlier versions captured foreground shells too; drop them.
    const isKept = (n: number, shells: readonly Shell[]) => shells.some(one => one.n === n)
    const kept = await update($, shellsAtom, list => list.filter(one => one.isBackground && one.taskId))
    await update($, slotsAtom, list => list.filter(n => isKept(n, kept)))
    await update($, queueAtom, list => list.filter(n => isKept(n, kept)))

    // After a reload, show again whatever was seated.
    const seated = await read($, slotsAtom)
    if (seated.length > 0) void $.ui.open({ id: PANE_ID, title: 'Shells' })

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') {
      if (e.tool === 'TaskStop') {
        const ran = await next(e)
        const id = e.task_id ?? e.shell_id
        if (!ran.deny && !ran.isError && id) {
          const shell = (await read($, shellsAtom)).find(one => one.taskId === id && !one.isFinal)
          if (shell) await finish($, shell.n, { status: 'killed' })
        }

        return ran
      }

      return next(e)
    }

    // Only shells that end up in the background are watched: started with
    // run_in_background, or moved there later (Ctrl+B, a timeout). Either way
    // the call returns once the shell is backgrounded, carrying its task id.
    const ran = await next(e)
    const taskId = (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId
    if (ran.deny !== undefined || !taskId) return ran

    const path = ran.text?.match(/([A-Za-z]:)?[^\s"'`]*[\\/]tasks[\\/][^\s"'`]+\.output/)?.[0]
    if (path) {
      const dir = path.replace(/[\\/][^\\/]+$/, '')
      await update($, tasksDirAtom, () => dir)
    }

    // update() retries on a version miss, so parallel calls each get their own number.
    const n = (await update($, nextNAtom, value => value + 1)) - 1
    const shell: Shell = {
      n,
      toolUseId: e.tool_use_id ?? String(n),
      tool: e.tool,
      command: e.command,
      description: e.description,
      agentId: e.agentId,
      isBackground: true,
      status: 'running',
      startedAt: await $.clock.now(),
      taskId,
      isFinal: false,
    }
    await update($, shellsAtom, list => [...list, shell])
    await setOutput($, n, '')
    await refreshStatus($)
    await offer($, n, false)

    return ran
  })

  // Background shells finish later: the engine tells the model with a task notification row.
  on('session.append', async ($, e, next) => {
    // Read the row before handing it on: storing it changes nothing we need.
    const raw = JSON.stringify(e.message.content ?? '')
    if (!raw.includes('task-notification')) return next(e)

    const body = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    for (const block of body.split(/<task-notification>/).slice(1)) {
      const taskId = block.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim()
      const said = block.match(/<status>([^<]+)<\/status>/)?.[1]?.trim().toLowerCase()
      if (!taskId || !said) continue
      const shell = (await read($, shellsAtom)).find(one => one.taskId === taskId && !one.isFinal)
      if (!shell) continue

      const dir = await read($, tasksDirAtom)
      const text = dir ? await $.fs.read(`${dir}/${taskId}.output`).catch(() => undefined) : undefined
      if (text !== undefined) await setOutput($, shell.n, text)
      const status: ShellStatus = /kill|stop/.test(said) ? 'killed' : /fail|error/.test(said) ? 'failed' : 'done'
      const exitCode = exitCodeIn(block) ?? (status === 'done' ? 0 : undefined)
      await finish($, shell.n, { status, exitCode })
      lastLength.delete(shell.n)
    }

    return next(e)
  })

  // The person closed the whole pane (its close mark or Esc): hide everything.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person' && e.id === PANE_ID) {
      await update($, slotsAtom, () => [])
      await update($, queueAtom, () => [])
    }

    return closed
  })

  on('command.run', { command: 'shells-list' }, async $ => {
    const shells = await read($, shellsAtom)
    if (shells.length === 0) return { text: 'No shells yet.' }
    const slots = await read($, slotsAtom)
    const queue = await read($, queueAtom)
    const now = await $.clock.now()
    const lines = shells.map(shell => {
      const seconds = Math.round(((shell.endedAt ?? now) - shell.startedAt) / 1000)
      const where = slots.includes(shell.n) ? 'shown' : queue.includes(shell.n) ? 'queued' : 'hidden'
      const agent = shell.agentId ? ' [subagent]' : ''

      return `#${shell.n}  ${statusLabel(shell)}  ${seconds}s  ${where}${agent}  ${clip(shell.command.replace(/\s+/g, ' '), 80)}`
    })

    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'shell' }, async ($, e) => {
    const shells = await read($, shellsAtom)
    const arg = e.args.trim().replace(/^#/, '')
    // Bare /shell shows every running shell; with none running, the newest.
    const running = shells.filter(one => one.status === 'running')
    const picked =
      arg !== ''
        ? shells.filter(one => one.n === Number(arg))
        : running.length > 0
          ? running
          : shells.slice(-1)
    if (picked.length === 0) {
      return { text: arg === '' ? 'No shells yet.' : `No shell #${arg}. /shells-list lists them.` }
    }

    // Offered newest first so the oldest ends up at the head of the queue.
    for (const shell of [...picked].reverse()) await offer($, shell.n, true)
    const slots = await read($, slotsAtom)
    const shown = picked.filter(one => slots.includes(one.n)).map(one => `#${one.n}`)
    const queued = picked.filter(one => !slots.includes(one.n)).map(one => `#${one.n}`)

    return {
      text: [
        shown.length > 0 ? `Showing ${shown.join(', ')}.` : '',
        queued.length > 0 ? `Queued next: ${queued.join(', ')}.` : '',
      ].filter(Boolean).join(' '),
    }
  })

  on('command.run', { command: 'shell-close' }, async ($, e) => {
    const arg = e.args.trim().replace(/^#/, '') || 'done'
    const count =
      arg === 'all'
        ? await closeWhere($, () => true, true)
        : arg === 'done'
          ? await closeWhere($, one => one.status !== 'running')
          : await closeWhere($, one => one.n === Number(arg), true)

    return { text: `Closed ${count} shell pane${count === 1 ? '' : 's'}.` }
  })

  on('command.run', { command: 'shell-clear' }, async $ => {
    const shells = await read($, shellsAtom)
    const finished = shells.filter(one => one.status !== 'running')
    for (const shell of finished) {
      await release($, shell.n)
      await setOutput($, shell.n, '')
    }
    await update($, shellsAtom, list => list.filter(one => one.status === 'running'))

    return { text: `Forgot ${finished.length} finished shell${finished.length === 1 ? '' : 's'}.` }
  })

  // Each window scrolls on its own: the wheel moves the one under the pointer,
  // the scroll keys the one the wheel last moved (or the only one shown).
  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const slots = await read($, slotsAtom)
    if (slots.length === 0) return {}
    const { height, room } = layout(e.bodyRows, slots.length)
    const n = e.pointer
      ? slots[Math.floor(e.pointer.row / height)]
      : lastScrolled !== undefined && slots.includes(lastScrolled)
        ? lastScrolled
        : slots.length === 1
          ? slots[0]
          : undefined
    if (n === undefined) return {}
    if (e.pointer) lastScrolled = n

    const length = linesOf(await readOutput($, n)).length
    const last = Math.max(0, length - room)
    const top = topOf((await read($, scrollAtom))[String(n)], length, room)
    const moved = Math.min(Math.max(0, top + e.by), last)
    await setTop($, n, moved >= last ? undefined : moved)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const shells = await read($, shellsAtom)
    const shown = (await read($, slotsAtom))
      .map(n => shells.find(one => one.n === n))
      .filter((one): one is Shell => one !== undefined)
    if (shown.length === 0) return next(e)
    const outputs = await Promise.all(shown.map(shell => readOutput($, shell.n)))
    const queued = (await read($, queueAtom)).length
    const saved = await read($, scrollAtom)
    // Read so the poll's once-a-second write redraws the run times.
    const now = Math.max(await read($, nowAtom), await $.clock.now())
    const { Box, Text, Button } = $.ui.resolve(e)

    const columns = Math.max(10, e.props.bodyColumns - 2)
    const total = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30
    const { height, room } = layout(total, shown.length)

    return (
      <Box flexDirection="column">
        {shown.map((shell, index) => {
          const lines = linesOf(outputs[index] ?? '')
          const top = topOf(saved[String(shell.n)], lines.length, room)
          const tail = lines.slice(top, top + room)
          const below = lines.length - top - tail.length
          const color = shell.status === 'failed' ? 'error' : shell.status === 'done' ? 'success' : undefined

          return (
            <Box
              key={`shell-${shell.n}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={color}
              height={height}
              overflow="hidden"
            >
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold wrap="truncate-end">
                  #{shell.n}
                  {top > 0 && <Text dimColor>{` ↑${top}`}</Text>}
                  {below > 0 && <Text dimColor>{` ↓${below}`}</Text>}
                  {` ${label(shell)}`}
                </Text>
                <Box flexDirection="row" gap={1}>
                  {below > 0 && (
                    <Button
                      key={`end-${shell.n}`}
                      label="end"
                      dimColor
                      onPress={() => setTop($, shell.n, undefined)}
                    />
                  )}
                  <Button
                    key={`close-${shell.n}`}
                    hotkey={String(index + 1)}
                    label="close"
                    dimColor
                    onPress={() => release($, shell.n)}
                  />
                </Box>
              </Box>
              <Text dimColor wrap="truncate-end">
                {shell.tool === 'PowerShell' ? 'PS> ' : '$ '}
                {clip(shell.command.replace(/\s+/g, ' '), columns - 4)}
              </Text>
              {/* The status line follows the last output line, not the window's bottom edge. */}
              <Box flexDirection="column" overflow="hidden">
                {tail.length === 0 && (
                  <Text dimColor>{shell.status === 'running' ? 'waiting for output…' : '(no output)'}</Text>
                )}
                {tail.map(line => (
                  <Text wrap="truncate-end">
                    {line === '' ? ' ' : clip(line, columns)}
                  </Text>
                ))}
                <Text wrap="truncate-end">
                  <Text color={color}>{statusLabel(shell)}</Text>
                  <Text dimColor>{` · ${elapsed((shell.endedAt ?? now) - shell.startedAt)}`}</Text>
                </Text>
              </Box>
            </Box>
          )
        })}
        <Box flexDirection="row" gap={1}>
          <Button
            key="close-done"
            label="close finished"
            dimColor
            onPress={() => closeWhere($, one => one.status !== 'running')}
          />
          {queued > 0 && <Text dimColor>+{queued} queued</Text>}
        </Box>
      </Box>
    )
  })
}
