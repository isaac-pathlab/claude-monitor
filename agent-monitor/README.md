# agent-monitor

A Claude Code mod that shows the steps of the subagents Claude starts, live, in an **Agents** pane beside the transcript: each agent's text in full, and its tool calls grouped the way the transcript groups them ("Ran 2 shell commands", "Read 3 files"). Thinking is never shown.

- Captures every subagent, background and foreground. Teammates are left out.
- Up to **3 windows** stacked in one pane, equal height. Further agents wait in a queue; closing a window lets the next one in.
- A subagent started by another subagent gets its own window, with `from #n` in its title.
- Windows **never close on their own** when an agent finishes. The line under the steps and the border show the status: `● running`, `◐ waiting` (on its own background work), `✓ done`, `✗ failed`, `■ killed`. A failed tool call shows its group as `✗`.
- That status line, right under the last step, also shows the tool-use count and the run time, which ticks each second while the agent runs.
- Each window scrolls on its own: the mouse wheel moves the window under the pointer, the scroll keys the one last wheeled. Scrolled up, a window stays put (`↑N ↓N` in its title); `[ end ]` or scrolling back down follows new steps again.
- Each window has a clickable `[ close ]` (keys `1`–`3` while the pane is focused); `[ close finished ]` sits at the bottom.

## Commands

| Command | What it does |
| --- | --- |
| `/agents-list` | List this session's subagents: number, status, run time, shown/queued/hidden, type, parent |
| `/agent [n]` | Show agent `n`. With no number: every running agent, or the newest if none run. Full pane: goes to the front of the queue |
| `/agent-close <n\|done\|all>` | Close windows (`done` is the default) |
| `/agent-clear` | Forget finished agents |

Closing the whole pane (its `[X]`, Esc, or ctrl+x x) hides every window and clears the queue; `/agent` brings them back.

## Install

```
/plugin install agent-monitor --marketplace isaac-pathlab/claude-monitor
```

## Notes

- Steps come from the rows each subagent's loop writes to the transcript; status comes from the session's agent list, checked every second.
- The agent list lives for the session only; the last 500 steps of each agent are kept.
- Panes the mod opens on its own appear when the terminal is at least 144 columns wide; otherwise a toast points to `/agent n`.

## Development

```
claude --plugin-dir <path-to-clone>/agent-monitor
claude plugin validate agent-monitor
claude plugin test agent-monitor
```

## License

[MIT](LICENSE)
