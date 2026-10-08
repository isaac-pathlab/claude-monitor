# shell-monitor

A Claude Code mod that shows the live output (stdout + stderr) of the background shells Claude starts, in a **Shells** pane beside the transcript.

- Captures Bash/PowerShell calls that end up in the background: started with `run_in_background`, or moved there later (Ctrl+B, a timeout). Foreground commands are ignored.
- Up to **3 windows** stacked in one pane, equal height. Further shells wait in a queue; closing a window lets the next one in.
- Windows **never close on their own** when a command finishes. The title and border show the status: `● running`, `✓ exit 0`, `✗ exit N`, `■ killed`.
- Each window scrolls on its own: the mouse wheel moves the window under the pointer, the scroll keys the one last wheeled. Scrolled up, a window stays put (`↑N ↓N` in its title); `[ end ]` or scrolling back down follows new output again.
- Each window has a clickable `[ close ]` (keys `1`–`3` while the pane is focused); `[ close finished ]` sits at the bottom.

## Commands

| Command | What it does |
| --- | --- |
| `/shells-list` | List this session's background shells: number, status, run time, shown/queued/hidden |
| `/shell [n]` | Show shell `n`. With no number: every running shell, or the newest if none run. Full pane: goes to the front of the queue |
| `/shell-close <n\|done\|all>` | Close windows (`done` is the default) |
| `/shell-clear` | Forget finished shells |

Closing the whole pane (its `[X]`, Esc, or ctrl+x x) hides every window and clears the queue; `/shell` brings them back.

## Install

```
/plugin install shell-monitor --marketplace isaac-pathlab/claude-shell-monitor
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every project).

From a local clone instead (`git clone https://github.com/isaac-pathlab/claude-shell-monitor`):

```
claude plugin marketplace add <path-to-clone>
claude plugin install shell-monitor@shell-monitor
```

Edits to a local clone are picked up with `/reload-plugins`.

## Notes

- Output is read from the file Claude Code writes for each background task, about every 0.4 s.
- The shell list lives for the session only; the last 200 KB of each shell's output is kept.
- Panes the mod opens on its own appear when the terminal is at least 144 columns wide; otherwise a toast points to `/shell n`.

## Development

```
claude --plugin-dir <path-to-clone>   # load for one session, hot-reloads on save
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)
