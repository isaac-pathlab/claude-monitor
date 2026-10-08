import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register } from 'claude-code'

import type { AgentRun, AgentRunStatus, FeedLine } from '../types'

const MAX_PANES = 3
const POLL_MS = 1000
const FEED_CAP = 500
// One pane holding up to MAX_PANES stacked agent windows: the engine shows
// several panes as tabs, so the stacking is drawn inside a single pane.
const PANE_ID = 'agents'

const agentsAtom = atom({ plugin: 'agent-monitor', key: 'agents' } as const, [])
const slotsAtom = atom({ plugin: 'agent-monitor', key: 'slots' } as const, [])
const queueAtom = atom({ plugin: 'agent-monitor', key: 'queue' } as const, [])
const nextNAtom = atom({ plugin: 'agent-monitor', key: 'nextN' } as const, 1)
// Per window, the first row shown while scrolled up; absent means follow the end.
const scrollAtom = atom({ plugin: 'agent-monitor', key: 'scroll' } as const, {})
// The time the windows' run times count to; the poll moves it while any agent runs.
const nowAtom = atom({ plugin: 'agent-monitor', key: 'now' } as const, 0)

type $ = EngineInterface

const glyph: Record<AgentRunStatus, string> = {
  running: '●',
  waiting: '◐',
  done: '✓',
  failed: '✗',
  killed: '■',
}

const isFinal = (run: AgentRun) => run.status === 'done' || run.status === 'failed' || run.status === 'killed'

const statusLabel = (run: AgentRun) => `${glyph[run.status]} ${run.status}`

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

const label = (run: AgentRun) => clip(run.description.replace(/\s+/g, ' ').trim() || run.subagentType, 40)

const stripAnsi = (text: string) =>
  text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

const statusOf = (status: AgentStatus): AgentRunStatus =>
  status === 'waiting' || status === 'idle'
    ? 'waiting'
    : status === 'completed'
      ? 'done'
      : status === 'failed' || status === 'killed'
        ? status
        : 'running'

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** A group of consecutive calls of one tool, in the transcript's words. */
function toolLabel(tool: string, count: number) {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `Ran ${plural(count, 'shell command')}`
    case 'Read':
      return `Read ${plural(count, 'file')}`
    case 'Edit':
      return `Edited ${plural(count, 'file')}`
    case 'Write':
      return `Wrote ${plural(count, 'file')}`
    case 'Grep':
    case 'Glob':
      return `Searched ${plural(count, 'time')}`
    case 'WebFetch':
      return `Fetched ${plural(count, 'page')}`
    case 'WebSearch':
      return `Searched the web ${plural(count, 'time')}`
    case 'Agent':
      return `Spawned ${plural(count, 'agent')}`
    default:
      return `Called ${tool} ${plural(count, 'time')}`
  }
}

const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

type Row = { text: string; isDim: boolean; isError: boolean }

/** The feed as the window draws it: text wrapped to `columns`, one row per tool group. */
function rowsOf(feed: readonly FeedLine[], columns: number) {
  const rows: Row[] = []
  for (const line of feed) {
    if (line.kind === 'tools') {
      const text = `${line.isError ? '✗ ' : '⎿ '}${toolLabel(line.tool, line.count)}`
      rows.push({ text: clip(text, columns), isDim: true, isError: line.isError })
      continue
    }
    if (rows.length > 0) rows.push({ text: '', isDim: false, isError: false })
    for (const part of stripAnsi(line.text).replace(/\r\n/g, '\n').split('\n')) {
      if (part === '') {
        rows.push({ text: '', isDim: false, isError: false })
        continue
      }
      for (let at = 0; at < part.length; at += columns) {
        rows.push({ text: part.slice(at, at + columns), isDim: false, isError: false })
      }
    }
  }

  return rows
}

/** Equal window heights: the footer row takes 1, each window splits the rest. */
const layout = (total: number, count: number) => {
  const height = Math.max(5, Math.floor((total - 1) / count))

  // Border 2 + header 1 + the status line under the steps 1.
  return { height, room: Math.max(1, height - 4) }
}

/** The first row a window shows, its saved place clamped to the rows. */
const topOf = (saved: number | undefined, length: number, room: number) => {
  const last = Math.max(0, length - room)

  return saved === undefined ? last : Math.min(Math.max(0, saved), last)
}

/** The window's text width, from the pane body's columns. */
const columnsOf = (bodyColumns: number) => Math.max(10, bodyColumns - 2)

const readFeed = async ($: $, n: number) => (await $.state.get({ plugin: 'agent-monitor', key: 'feed', id: String(n) })).value ?? []

function patchAgent($: $, n: number, patch: Partial<AgentRun>) {
  return update($, agentsAtom, list => list.map(one => (one.n === n ? { ...one, ...patch } : one)))
}

// Module-local bookkeeping; lost on reload, which the scroll keys tolerate.
let isPolling = false
// The window the wheel last moved: where the scroll keys go.
let lastScrolled: number | undefined
// The pane's body width at the last draw, which the scroll hook wraps to.
let lastColumns = 58

/** Saves window n's first row; at the end it follows new rows again. */
function setTop($: $, n: number, top: number | undefined) {
  return update($, scrollAtom, map => {
    const { [String(n)]: _, ...rest } = map

    return top === undefined ? rest : { ...rest, [String(n)]: top }
  })
}

async function openPane($: $, n: number, isAsked: boolean) {
  const opened = await $.ui.open({ id: PANE_ID, title: 'Agents' })
  if (!opened.isPlaced && !isAsked) {
    $.ui.toast(`agent #${n} waiting: widen the terminal or run /agent ${n}`)
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

/** Shows agent n: a free slot now, else the queue (its head when asked). */
async function offer($: $, n: number, isAsked: boolean) {
  const slots = await read($, slotsAtom)
  if (slots.includes(n)) return
  await update($, queueAtom, list => {
    const rest = list.filter(one => one !== n)

    return isAsked ? [n, ...rest] : [...rest, n]
  })
  await promote($, isAsked)
}

/** Takes agent n out of its pane or the queue and fills the freed slot. */
async function release($: $, n: number, isPaneGone = false) {
  await update($, slotsAtom, list => list.filter(one => one !== n))
  await update($, queueAtom, list => list.filter(one => one !== n))
  await setTop($, n, undefined)
  await promote($, true)
  if (!isPaneGone && (await read($, slotsAtom)).length === 0) await $.ui.close({ id: PANE_ID })
}

async function refreshStatus($: $) {
  const running = (await read($, agentsAtom)).filter(one => !isFinal(one)).length
  $.ui.status(running > 0 ? `agents: ${running} running` : undefined)
}

/**
 * Brings the tracked agents' status in line with `$.agent.list()`. A finished
 * foreground agent leaves the list: one missing from it has ended, as `gone` says.
 */
async function syncStatus($: $, only?: string, gone: AgentRunStatus = 'done') {
  const live = (await read($, agentsAtom)).filter(one => !isFinal(one) && (!only || one.agentId === only))
  if (live.length === 0) return
  const listed = await $.agent.list()
  let isEnded = false
  for (const run of live) {
    const info = listed.find(one => one.id === run.agentId)
    const status = info ? statusOf(info.status) : gone
    if (status === run.status) continue
    const patch: Partial<AgentRun> = { status }
    if (status === 'done' || status === 'failed' || status === 'killed') {
      patch.endedAt = await $.clock.now()
      isEnded = true
    }
    await patchAgent($, run.n, patch)
  }
  if (isEnded) await refreshStatus($)
}

async function poll($: $) {
  if (isPolling) return
  isPolling = true
  try {
    await syncStatus($)
    // Each write redraws the pane, so the run times tick once a second.
    if ((await read($, agentsAtom)).some(one => !isFinal(one))) {
      const now = await $.clock.now()
      await update($, nowAtom, () => now)
    }
  } finally {
    isPolling = false
  }
}

/** Adds one assistant or tool-result row's visible steps to agent n's feed. */
async function record($: $, run: AgentRun, type: string, content: readonly { type: string; [field: string]: unknown }[]) {
  let added = 0
  await update($, { plugin: 'agent-monitor', key: 'feed', id: String(run.n) }, current => {
    const feed = [...(current ?? [])]
    added = 0
    if (type === 'assistant') {
      for (const block of content) {
        const last = feed[feed.length - 1]
        if (block.type === 'text') {
          const text = String(block.text ?? '').trim()
          if (text !== '') feed.push({ kind: 'text', text })
        } else if (block.type === 'tool_use') {
          const tool = String(block.name ?? 'tool')
          const id = String(block.id ?? '')
          added += 1
          if (last?.kind === 'tools' && last.tool === tool) {
            feed[feed.length - 1] = { ...last, count: last.count + 1, toolUseIds: [...last.toolUseIds, id] }
          } else {
            feed.push({ kind: 'tools', tool, count: 1, isError: false, toolUseIds: [id] })
          }
        }
        // thinking, redacted_thinking and unknown blocks are never shown.
      }
    } else {
      for (const block of content) {
        if (block.type !== 'tool_result' || block.is_error !== true) continue
        const id = String(block.tool_use_id ?? '')
        const at = feed.findIndex(line => line.kind === 'tools' && line.toolUseIds.includes(id))
        const line = feed[at]
        if (line?.kind === 'tools') feed[at] = { ...line, isError: true }
      }
    }

    return feed.length <= FEED_CAP ? feed : feed.slice(feed.length - FEED_CAP)
  })
  if (added > 0) await patchAgent($, run.n, { toolUses: run.toolUses + added })
}

/** Closes matching shown windows; with `isQueueToo`, drops matching queued ones as well. */
async function closeWhere($: $, pick: (run: AgentRun) => boolean, isQueueToo = false) {
  const agents = await read($, agentsAtom)
  const slots = await read($, slotsAtom)
  const queue = await read($, queueAtom)
  const targets = agents.filter(
    one => pick(one) && (slots.includes(one.n) || (isQueueToo && queue.includes(one.n))),
  )
  for (const run of targets) await release($, run.n)

  return targets.length
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const spec of [
      { name: 'agents-list', description: 'List the subagents Claude started this session' },
      { name: 'agent', description: 'Show an agent in a pane; with no number, every running one (else the newest)', argumentHint: '[n]' },
      { name: 'agent-close', description: 'Close agent panes', argumentHint: '<n|done|all>' },
      { name: 'agent-clear', description: 'Forget finished agents' },
    ]) {
      await $.command.register({ ...spec, immediate: true })
    }

    $.clock.every(POLL_MS, () => void poll($))

    // After a reload, show again whatever was seated.
    const seated = await read($, slotsAtom)
    if (seated.length > 0) void $.ui.open({ id: PANE_ID, title: 'Agents' })

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.deny !== undefined || !spawned.agentId) return spawned
    // Teammates live their own lives; this pane follows subagents only.
    if (spawned.teammateId || e.isTeammate) return spawned

    // update() retries on a version miss, so parallel spawns each get their own number.
    const n = (await update($, nextNAtom, value => value + 1)) - 1
    const run: AgentRun = {
      n,
      agentId: spawned.agentId,
      parentAgentId: e.parentAgentId,
      description: e.description,
      subagentType: e.subagentType,
      isBackground: e.background,
      status: 'running',
      startedAt: await $.clock.now(),
      toolUses: 0,
    }
    await update($, agentsAtom, list => [...list, run])
    await $.state.set({ plugin: 'agent-monitor', key: 'feed', id: String(n) }, [])
    await refreshStatus($)
    await offer($, n, false)

    return spawned
  })

  // Each row a subagent's loop keeps: its text and tool calls, never its thinking.
  on('session.append', async ($, e, next) => {
    const { message } = e
    if (!e.agentId || message.isMeta || (message.type !== 'assistant' && message.type !== 'user')) return next(e)
    const run = (await read($, agentsAtom)).find(one => one.agentId === e.agentId)
    if (!run) return next(e)

    // A user row counts only for its tool results: its text is the agent's prompt.
    await record($, run, message.type, message.content ?? [])

    return next(e)
  })

  // A subagent's run ended: settle its status now rather than at the next poll.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) {
      await syncStatus($, e.agentId, e.reason === 'aborted' ? 'killed' : e.reason === 'answer' ? 'done' : 'failed')
    }

    return done
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

  on('command.run', { command: 'agents-list' }, async $ => {
    const agents = await read($, agentsAtom)
    if (agents.length === 0) return { text: 'No agents yet.' }
    const slots = await read($, slotsAtom)
    const queue = await read($, queueAtom)
    const now = await $.clock.now()
    const lines = agents.map(run => {
      const where = slots.includes(run.n) ? 'shown' : queue.includes(run.n) ? 'queued' : 'hidden'
      const parent = agents.find(one => one.agentId === run.parentAgentId)
      const from = parent ? ` [from #${parent.n}]` : ''
      const mode = run.isBackground ? ' [background]' : ''

      return `#${run.n}  ${statusLabel(run)}  ${elapsed((run.endedAt ?? now) - run.startedAt)}  ${where}  ${run.subagentType}${mode}${from}  ${clip(run.description.replace(/\s+/g, ' '), 80)}`
    })

    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'agent' }, async ($, e) => {
    const agents = await read($, agentsAtom)
    const arg = e.args.trim().replace(/^#/, '')
    // Bare /agent shows every running agent; with none running, the newest.
    const running = agents.filter(one => !isFinal(one))
    const picked =
      arg !== ''
        ? agents.filter(one => one.n === Number(arg))
        : running.length > 0
          ? running
          : agents.slice(-1)
    if (picked.length === 0) {
      return { text: arg === '' ? 'No agents yet.' : `No agent #${arg}. /agents-list lists them.` }
    }

    // Offered newest first so the oldest ends up at the head of the queue.
    for (const run of [...picked].reverse()) await offer($, run.n, true)
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

  on('command.run', { command: 'agent-close' }, async ($, e) => {
    const arg = e.args.trim().replace(/^#/, '') || 'done'
    const count =
      arg === 'all'
        ? await closeWhere($, () => true, true)
        : arg === 'done'
          ? await closeWhere($, isFinal)
          : await closeWhere($, one => one.n === Number(arg), true)

    return { text: `Closed ${count} agent pane${count === 1 ? '' : 's'}.` }
  })

  on('command.run', { command: 'agent-clear' }, async $ => {
    const agents = await read($, agentsAtom)
    const finished = agents.filter(isFinal)
    for (const run of finished) {
      await release($, run.n)
      await $.state.set({ plugin: 'agent-monitor', key: 'feed', id: String(run.n) }, [])
    }
    await update($, agentsAtom, list => list.filter(one => !isFinal(one)))

    return { text: `Forgot ${finished.length} finished agent${finished.length === 1 ? '' : 's'}.` }
  })

  // Each window scrolls on its own, in wrapped rows: the wheel moves the one
  // under the pointer, the scroll keys the one the wheel last moved (or the only one shown).
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

    const length = rowsOf(await readFeed($, n), lastColumns).length
    const last = Math.max(0, length - room)
    const top = topOf((await read($, scrollAtom))[String(n)], length, room)
    const moved = Math.min(Math.max(0, top + e.by), last)
    await setTop($, n, moved >= last ? undefined : moved)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const agents = await read($, agentsAtom)
    const shown = (await read($, slotsAtom))
      .map(n => agents.find(one => one.n === n))
      .filter((one): one is AgentRun => one !== undefined)
    if (shown.length === 0) return next(e)
    const feeds = await Promise.all(shown.map(run => readFeed($, run.n)))
    const queued = (await read($, queueAtom)).length
    const saved = await read($, scrollAtom)
    // Read so the poll's once-a-second write redraws the run times.
    const now = Math.max(await read($, nowAtom), await $.clock.now())
    const { Box, Text, Button } = $.ui.resolve(e)

    const columns = columnsOf(e.props.bodyColumns)
    lastColumns = columns
    const total = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30
    const { height, room } = layout(total, shown.length)

    return (
      <Box flexDirection="column">
        {shown.map((run, index) => {
          const rows = rowsOf(feeds[index] ?? [], columns)
          const top = topOf(saved[String(run.n)], rows.length, room)
          const tail = rows.slice(top, top + room)
          const below = rows.length - top - tail.length
          const color = run.status === 'failed' ? 'error' : run.status === 'done' ? 'success' : undefined
          const parent = agents.find(one => one.agentId === run.parentAgentId)

          return (
            <Box
              key={`agent-${run.n}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={color}
              height={height}
              overflow="hidden"
            >
              <Box flexDirection="row" justifyContent="space-between">
                {/* Scroll marks lead: truncation cuts the end of the title. */}
                <Text bold wrap="truncate-end">
                  #{run.n}
                  {top > 0 && <Text dimColor>{` ↑${top}`}</Text>}
                  {below > 0 && <Text dimColor>{` ↓${below}`}</Text>}
                  {` ${label(run)}`}
                  <Text dimColor>{` · ${run.subagentType}${parent ? ` from #${parent.n}` : ''}`}</Text>
                </Text>
                <Box flexDirection="row" gap={1}>
                  {below > 0 && (
                    <Button
                      key={`end-${run.n}`}
                      label="end"
                      dimColor
                      onPress={() => setTop($, run.n, undefined)}
                    />
                  )}
                  <Button
                    key={`close-${run.n}`}
                    hotkey={String(index + 1)}
                    label="close"
                    dimColor
                    onPress={() => release($, run.n)}
                  />
                </Box>
              </Box>
              {/* The status line follows the last step, not the window's bottom edge. */}
              <Box flexDirection="column" overflow="hidden">
                {tail.length === 0 && <Text dimColor>{isFinal(run) ? '(no steps)' : 'starting…'}</Text>}
                {tail.map(row => (
                  <Text wrap="truncate-end" dimColor={row.isDim && !row.isError} color={row.isError ? 'error' : undefined}>
                    {row.text === '' ? ' ' : row.text}
                  </Text>
                ))}
                <Text wrap="truncate-end">
                  <Text color={color}>{statusLabel(run)}</Text>
                  <Text dimColor>
                    {` · ${plural(run.toolUses, 'tool use')} · ${elapsed((run.endedAt ?? now) - run.startedAt)}`}
                  </Text>
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
            onPress={() => closeWhere($, isFinal)}
          />
          {queued > 0 && <Text dimColor>+{queued} queued</Text>}
        </Box>
      </Box>
    )
  })
}
