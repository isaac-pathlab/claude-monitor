# claude-monitor

Two Claude Code mods that show, live in a pane beside the transcript, the work Claude runs out of sight:

| Plugin | Pane | What it shows |
| --- | --- | --- |
| [shell-monitor](shell-monitor/README.md) | **Shells** | The live output of the background shells Claude starts |
| [agent-monitor](agent-monitor/README.md) | **Agents** | Each subagent's steps: its text in full and its tool calls grouped ("Ran 2 shell commands"), never its thinking |

Both draw the same way:

- Up to **3 windows** stacked in one pane, equal height. More wait in a queue; closing a window lets the next one in.
- Windows **never close on their own**. A status line right under the last line shows `● running` (or `◐ waiting` for an agent waiting on its own background work), then `✓` / `✗` / `■`, with a run time that ticks each second. The border turns green or red when it ends.
- Each window scrolls on its own: the mouse wheel moves the window under the pointer, the scroll keys the one last wheeled. Scrolled up, a window stays put (`↑N ↓N` in its title); `[ end ]` or scrolling back down follows new lines again.
- Each window has a clickable `[ close ]` (keys `1`–`3` while the pane is focused); `[ close finished ]` sits at the bottom.
- Commands to list, show, close and clear: `/shells-list`, `/shell`, `/shell-close`, `/shell-clear` and `/agents-list`, `/agent`, `/agent-close`, `/agent-clear`.

## Install

```
/plugin install shell-monitor --marketplace isaac-pathlab/claude-monitor
/plugin install agent-monitor --marketplace isaac-pathlab/claude-monitor
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every project). Install either one or both.

From a local clone instead (`git clone https://github.com/isaac-pathlab/claude-monitor`):

```
claude plugin marketplace add <path-to-clone>
claude plugin install shell-monitor@shell-monitor
claude plugin install agent-monitor@shell-monitor
```

Edits to a local clone are picked up with `/reload-plugins`.

## Development

Each plugin lives in its own folder (`shell-monitor/`, `agent-monitor/`); the marketplace file at the root lists both.

```
claude --plugin-dir <path-to-clone>/shell-monitor   # load for one session, hot-reloads on save
claude plugin validate .                              # the marketplace
claude plugin validate shell-monitor
claude plugin test shell-monitor
claude plugin test agent-monitor
```

## License

[MIT](LICENSE)
