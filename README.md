# Patchbay

Tasks keep explicit outcomes separate from agent activity. Use `patchbay task create`,
`list`, `show`, `submit` and `verify` to record work and real command checks. The board
shows task outcomes and lets you accept a submitted result after its required checks
pass at the current revision. Session cards show their associated tasks. See the
[task command guide](resources/skill/skills/patchbay/tasks.md). Existing `--after`
connections still wait for a completed agent turn.

A Windows canvas of live terminals, Claude Code and Codex agents, notes and whiteboards. For one person, on one PC.

## Build and run

Patchbay is built from this folder's code. There are three ways to run it, depending on what you're doing.

| To | Run | You get |
|---|---|---|
| Work on the code, with reloading | `npm run dev` | The app, run from source, reloading as you edit |
| Build the app to use | `npm run package` | `release\win-unpacked\Patchbay.exe`, which runs from that folder, with nothing installed |
| Build an installer | `npm run dist` | The same, plus `release\Patchbay-Setup-0.1.0.exe`, which installs it |

### What you need

- Windows, Node 22 and git.
- The `claude` command for Claude nodes, and the `codex` command for Codex nodes.
- The GitHub CLI (`gh`) only for issues and pull requests on the board.

Node has to stay on PATH for the built app too, because agents' hooks and the `patchbay` command run on it.

### First time

```sh
npm install
```

### Run from source

```sh
npm run dev
```

### Build the app from the code

```sh
npm run package
```

This builds `release\win-unpacked\Patchbay.exe`. Run it from there, or pin it to the taskbar. Nothing is installed, so
building again replaces it.

### Build an installer

```sh
npm run dist
```

This builds the app as above and `release\Patchbay-Setup-0.1.0.exe`, named for the version in `package.json`. Running
the installer puts Patchbay in
`%LOCALAPPDATA%\Programs\patchbay`, for your Windows account only, with a Start menu entry and a desktop shortcut.
It updates an installed copy in place, and `release\Patchbay-Setup-0.1.0.exe /S` installs without asking. To remove
it, use **Uninstall Patchbay** in that folder or in Windows' installed apps.

The app and installer aren't signed, so Windows SmartScreen may warn the first time. Choose **More info**, then
**Run anyway**.

### Before you build over a copy you're using

A running Patchbay keeps the program's files open, so Windows won't let them be replaced. Before installing over an
installed copy, choose **File > Quit** in it: its sessions carry on, because the background session host runs from a
copy of the program of its own, in `%LOCALAPPDATA%\Patchbay\host-runtime`, which an install doesn't touch. Open the new
version and it reconnects to them as they are. Copies no host runs from are removed by themselves.

Sessions keep the host they started with, so a change to the host itself reaches them only after **File > Stop all
sessions and quit** once. A build run from `release\win-unpacked` works the same way. Before `npm install`, which
replaces node-pty in the repository, stop any copy run from source.

Your canvas, notes, whiteboards and settings live in `%APPDATA%\Patchbay`, apart from the program, so building,
installing and uninstalling leave them alone. See [Where data lives](#where-data-lives).

### Working on Patchbay from inside Patchbay

You can use an installed Patchbay, with Claude or Codex windows open on this repository, to change Patchbay itself.
What they run doesn't reach the copy you're using:

- `npm run dev` runs a copy from source with a **dev** label beside its name. It keeps its own canvas, settings and
  sessions in `%APPDATA%\Patchbay-dev`, with its own background host, so it opens alongside the installed copy and
  never sees or ends its sessions.
- The checks in `test/acceptance` each use a throwaway profile, and their windows open off to the side of your screens.
- `npm run build`, `npm run package` and `npm run dist` only write inside the repository.

To move to a new build without stopping the agents doing the work: run `npm run dist`, choose **File > Quit** in the
installed copy, run `release\Patchbay-Setup-0.1.0.exe`, and open Patchbay again. Every session, agents included, has
kept running throughout, and the new version picks them up where they are.

## Sessions keep running

Terminals, Claude nodes and run commands live in a background program, the session host, not in the app. They keep
running when Patchbay closes, crashes or is updated, and it reconnects to them when it opens, with what they printed
meanwhile. The host holds the newest 1 MB of each session's output.

| You do this | What happens |
|---|---|
| Close a node | Its session ends |
| Close the window | Patchbay stays in the tray, so it can still notify you and show approval buttons |
| **File > Quit (sessions keep running)** | The app exits, and sessions carry on |
| **File > Stop all sessions and quit** | Every session and the host end, then the app exits |
| **Settings > Background sessions > Stop** | Every session and the host end, and the app stays open |

Quitting asks first if a Claude node is working or waiting on you.

**While the app is closed,** nothing notifies you. A permission request goes to Claude's own prompt in its terminal,
which you can answer once you reconnect. The `patchbay` command says the app is closed and fails straight away.

**Status after reconnecting** comes only from what Claude's hooks reported while the app was away. A session with
nothing reported shows "unknown" until its next hook, never a guessed "idle".

**When a session has really died,** because the host was stopped or the PC restarted, it comes back as before.
Terminals start a new shell below their saved output and a divider, and don't rerun their command. Claude nodes resume
their conversations. Run commands stay stopped until you run them.

**The host ends by itself** in these cases, and never while the app is connected. The limits are in
`src/main/sessions/hostPolicy.ts`, and time only counts while the PC is awake.

| Case | After |
|---|---|
| Sessions running, but no app has connected | 7 days |
| Nothing running, and no app connected | 10 minutes |
| The profile's folder was deleted or replaced | 10 minutes |

**After an update,** if the running host speaks a different protocol, Patchbay stops nothing by itself. It asks whether
to stop those sessions and carry on, or quit and leave them running. `HOST_PROTOCOL` in
`src/main/sessions/hostProtocol.ts` has to go up whenever the protocol changes.

**If the host can't start,** Patchbay says so and runs sessions inside the app, where they end when it quits. It tries
the host again the next time it opens. Opening takes about 15 seconds in this case, as it waits for the host first.

## Where data lives

Everything is in `%APPDATA%\Patchbay`:

| Path | What it is |
|---|---|
| `canvas.json`, `canvas.json.bak` | The canvas and its backup. A damaged file is kept as `canvas.corrupt-*.json` |
| `scrollback\` | Each terminal's saved output |
| `pastes\` | Images pasted into terminals |
| `file-shelf.json` | Each project's Files shelf: the paths of files shared in it, the newest 2,000. Paths only, never copies |
| `Partitions\patchbay-browser*\` | Browser node storage: sign-ins and site data, apart from your own browser |
| `browser-shots\` | Screenshots agents took of browser nodes, the newest 50 |
| `browser-evidence.json` | Agents' recorded browser checks, for 30 days, the last 100. A file that can't be read is kept beside it as `.bad-*` |
| `browser-evidence-shots\` | The pictures those checks took, up to 128 MB |
| `files-touched.json` | Which files each agent session edited, and a git snapshot reference per turn: 300 files and 30 turns per session, dropped 3 days after its node is closed. `files-touched\objects\` holds the snapshots' git objects, kept out of your repositories: 10 days, up to 512 MB |
| `agent-edits.json` | Agents' changes to notes and whiteboards that you haven't kept or undone yet |
| `review-inbox.json` | Review inbox comments, review marks (the newest 20 per task) and chosen base branches. A file that can't be read is moved aside, and one with damaged records copied aside, as `review-inbox.json.bad-*` |
| `review-objects\` | Snapshots of working trees the review inbox compares with, one git object store per repository |
| `messages.json` | The last 300 messages nodes sent each other with `patchbay send`, shown when you click a cable |
| `searchindex.json` | The search index: a copy of the text of every conversation, note and message search can find. Saved every few minutes and at quit, and soon after a source is dropped. Safe to delete: it's built again |
| `whiteboards\` | Whiteboards agents exported with `patchbay whiteboard`, as PNG and SVG, the newest 50 |
| `whiteboards\images\` | Pictures pasted onto whiteboards. One no board uses is deleted at startup once it's a day old |
| `sessions\` | The hook settings passed to each Claude node |
| `control\endpoint.json`, `secret` | How sessions reach the app. Keep `secret` private. The endpoint file only exists while the app is open |
| `control\host-secret`, `host.json`, `host.log` | How the app reaches the session host, and what the host last did. Keep `host-secret` private |
| `control\missed\` | Hook events from while the app was closed, until it reconnects |
| `logs\patchbay.log` | When the window froze, stopped responding or crashed, how it recovered, and memory now and then. Up to 1 MB, with the one before kept as `patchbay.1.log`. Settings > Open log opens it |
| `settings.json` | Optional, and you create it |

### If the window freezes or crashes

Your terminals and agents run in a background process, not in the window, so the window can be reloaded without
losing anything. If it stops responding for 10 seconds, Patchbay offers **Reload window** and goes on waiting if you'd
rather; the question goes away by itself if the window recovers. If the window crashes, it reloads by itself, and asks
you only if that happens three times within two minutes. Each of these, and any freeze of two seconds or more, is noted
in the log above, which is the thing to share if Patchbay misbehaves.

### Git Bash's limit of 32 consoles

Git Bash can have at most 32 consoles in use at once across the whole PC. Each Git Bash terminal holds one, each agent
holds one while its shell tool runs a command, and so do Git Bash windows outside Patchbay. Past that, a new Git Bash
ends at once, and the window says so; agents' shell commands fail the same way. Close some terminals, or give some of
them another terminal profile (below), and press Restart.

**Terminal profiles** set what a new terminal starts: a program, its arguments (one per line, passed as they are), an
optional startup command typed once at its first prompt, and an optional folder. Set them under Settings > Terminals.
Git Bash, Windows PowerShell, Command Prompt, PowerShell 7 and WSL appear when installed; duplicate one to change it.
New terminal opens the default; the others are in the Add menu, the canvas menu, the palette, the New terminal form and
`patchbay open-terminal --profile NAME`. A terminal keeps its profile across restarts. If that profile is deleted, it
starts the default and says so. For example: `cmd.exe` with the two arguments `/k` and `C:\...\vcvars64.bat`, or Git
Bash with the startup command `cd ~/proj && nvm use`.

`settings.json` can set the shell run commands use (with no profiles saved yet, new terminals use it too) and the
permission mode for Claude nodes:

```json
{ "shell": "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "permissionMode": "default" }
```

`codexApproval` sets what Codex nodes may do without asking. `never` keeps Codex's sandbox but never asks: anything the
sandbox blocks comes back to Codex as a failure. `bypass` asks nothing and runs commands without the sandbox, so use it
only in folders you trust. Leave it out to keep Codex's own default. It's also under Settings > Agents.

```json
{ "codexApproval": "never" }
```

Settings > Agents has a switch for each agent, Claude Code and Codex, for when one's usage has run out or you don't want
it used. One stays on. With an agent off, nothing new of it starts: it leaves the menus, the dock and the palette,
restarting or resuming one of its windows is refused, a trigger aimed at one records a failed run, and `patchbay
open-agent` and `spawn-team` refuse it. Windows already running keep running. If the default agent is off, the other
stands in. A recipe that needs it says so, and starts only if you choose to use the other agent instead. Try another
approach offers only agents that are on, and won't start an attempt left on one that's off. In
`settings.json` it's `agentsOff`, the agents turned off:

```json
{ "agentsOff": "codex" }
```

`envNotPassed` lists name prefixes of environment variables that sessions don't inherit, separated by spaces or
commas. It's for starting Patchbay from inside another terminal app, whose sessions must not think Patchbay's are theirs:

```json
{ "envNotPassed": "OTHERAPP_" }
```

Patchbay doesn't edit `~/.claude`. It adds its hooks and skill to each session it starts.

## Check

```sh
npm test
npm run typecheck
```

The scripts in `test/acceptance` drive the real app and most start real Claude sessions, so they use some of your plan's quota.
Their app windows open beside your screens without taking focus, so a run doesn't pop up over what you're doing; set
`PB_SHOW=1` to watch one. `paths-real.cjs` prints paths and links the ways real tools do and checks each shows as a
link and copies correctly, using no quota.
`ui-sidebar.cjs` and `ui-windows.cjs` use a stand-in for Claude and spend none. `ui-real.cjs` makes a few small checks
with the real one.

`perf.cjs` puts many windows to work at once while someone types in another, and measures how long keys take to show,
the longest the window goes without drawing, and the CPU of each process and of the whole PC. With
`PB_PERF_KIND=claude` the windows are agents doing what Claude does as it works: redrawing, its status line, hooks
around each tool call and a growing transcript. `PB_PERF_SLOW=4` runs the window four times slower, as on a modest
laptop. `perf-bursts.cjs` times the moments every window has a lot to do at once: all of them reprinting their whole
conversation, being resized, and being rebuilt when you come back to a project. `perf-hidden.cjs` checks a minimized
window does next to nothing while busy windows keep printing, then catches up at once, and `perf-reopen.cjs` times
reopening a canvas of twenty terminals with full histories. `perf-tabs.cjs` spreads busy agents across project tabs.
None of these use quota. `real-tabs.cjs` does the same with real Claude windows on small coding tasks, reporting CPU
by program, and spends a little.

`lowend.cjs` runs any of them as if on a modest PC: the check and everything it starts share only the first few CPU
cores, for example `node test/acceptance/lowend.cjs 2 test/acceptance/perf-tabs.cjs`. `perf.cjs` can also trace every
process's threads (`PB_PERF_TRACE=<file>`) and draw at 4K scale (`PB_PERF_HIDPI=1`).

`update-live.cjs` replaces a packaged build's whole install folder while a session runs, as an installer does, and checks
the new version picks the session up still running; run it after `npm run package`.

`test/acceptance/host.cjs` checks that sessions outlive the app. It uses no quota unless you add `--real-claude`, and
`--packaged` runs it against the packaged build. `test/acceptance/quitloop.cjs` repeats quitting and counts how often
Electron's exit hangs and has to be ended by force. `triggers.cjs`, `runconfig.cjs` and `links.cjs` check triggers,
launch.json run nodes and the moving cables, using the stand-in Claude and no quota.

`whiteboard.cjs` (whiteboard export and pasted pictures) and `messages.cjs` (messages along cables, agents' note
changes, the palette) use no quota. Set `PB_USE_PACKAGED=1` to run either against the build from `npm run package`.
`team-real.cjs` starts a real lead and teammate on the packaged build to check they work as the Patchbay skill teaches,
and spends a little quota.

`--user-data-dir=<folder>` runs the app on a separate profile, away from your real canvas, with its own session host.

`node screenshot.js <out.png> --scene <name> [--size 900x620]` takes a picture of a seeded canvas. The scenes are in
`test/acceptance/scenes.cjs`.

## Sessions sidebar

- **Project** lists sessions under each open project, across all of them. Headers fold, and stay folded after a restart.
  A row shows its folder only when it isn't the project's folder.
- **Status** sorts every session by what it's doing: Need attention, Unread, Running, Idle and No status yet. Only a session
  whose Claude hooks said so is ever Idle. Queued and starting sessions go under Starting, ended ones under Stopped,
  and terminals and run commands, which can't report a status, under Terminals and commands. Each session appears once.
  A closed project's sessions stay out of this list unless they need you or have something to look at.
  Empty sections are left out, except Need attention, which says "All clear."
- **Stopped on an error.** When a Claude turn ends on an API error instead of finishing, its status stays unknown but
  its badge says why: "Usage limit until 00:30", "Rate limited", "Login failed", "Billing problem" or "Server error".
  It goes under Need attention. The reset time comes from Claude's status line, or from its message.
- **Peek:** on the Status tab, an agent row's magnifier (or Space on the row) shows what it last said, what it's
  waiting on if Patchbay can tell, and how long it has waited. Type a reply there: it goes the same way as
  `patchbay send`, once the agent is idle. Approve and deny stay in the window, which Open goes to.
- **Next needing you** (Ctrl+Shift+J, or the palette) goes to the agent that has waited longest at Need attention,
  in any project, and opens its peek. Press it again for the next. With "Also unread" ticked, Unread sessions follow.
- **Last activity** is held in memory, so after a restart a session shows no time until it next does something.
- **Pin:** pinned, the sidebar stays open. Unpinned, clicking the canvas hides it.
- **Closed conversations** reopens a closed Claude conversation, the same as the Closed conversations panel.

## Session windows

Each window's header has Refresh, Find, Name with AI, text size, Maximize and Close. On narrow windows the folder goes
first, then labels, and the text size folds into one button.

- **Refresh** draws the terminal view again from the session's output. The process keeps running. Restart is separate.
- **Name with AI** titles the window from recent output, only when clicked, and spends a little plan quota. It runs
  `claude -p` in an empty folder with no tools, hooks or saved conversation.
- **Text size** is for that window only and is saved with it. Click the number to go back to the global size.
- **Zoom to a node:** double-click an empty part of any node's header bar (a window, note, whiteboard, browser, trigger,
  or a group, which fits the whole group) and the canvas pans and zooms so it fills the view. Nothing moves or resizes.
  Double-click the header again, or press Esc, to go back to exactly the view from before; pan or zoom by hand in
  between and that's forgotten. The title still renames and the buttons still work. Esc stays with a terminal that has
  the keyboard, and with reduced motion turned on in Windows the view jumps instead of gliding.
- **Maximize** fills the canvas area without changing the saved layout. Esc or the same button restores it. While the
  terminal has the keyboard, Esc stays with the terminal, because that's how Claude is interrupted, so use F11 or the button.
- **Focus view** (Ctrl+Shift+L, or the grid on the dock) puts windows in split panes filling the app. Split a pane
  with the buttons on its bar and drag the dividers. An empty pane lists the windows not in the view, one click each,
  and clicking a session in the sidebar brings it into a pane. The pane you're typing in has a blue edge, and
  Ctrl+Shift+arrows move between panes. The **−** on a pane's bar takes it out of the view; the window keeps running on
  the canvas. Each project keeps its own layout.
- **Links and paths** in a terminal are underlined when you point at them. Clicking a web link opens it in your browser,
  including the hyperlinks Claude Code prints. Right-click one for **Copy link**, for a PC whose security settings stop
  links opening from another app. Clicking or right-clicking a file path offers Open, New terminal here, Copy path and
  Show in File Explorer. Paths are understood however they're written: `C:\a\b.ts`, `C:/a/b.ts`, Git Bash's
  `/c/a/b.ts`, `~/b.ts`, relative to the terminal's folder, `file:///` links, quoted with spaces, and with `:12:5` or
  `#L12` after them. Copy path gives the full Windows path. Links in notes and the chat view have Copy link too.
- **Subagents.** When a Claude window starts subagents, each one gets a small card beside it, joined by an Opened cable,
  with its type, task, how long it has run, its tool calls and its tokens (`~` while it runs: the size of its latest
  reply's context). Click a card to read its transcript. Finished cards stay 30 seconds, then fade. Eight show at most,
  the last as "+N more". The eye in the window's header counts this turn's subagents and hides or shows the cards. The
  cards aren't windows: they aren't saved, undone, listed or sent to. Codex windows don't have them yet.

## Files each agent edited

An agent's header and its row in the sidebar show **N files** once it has edited files with its own edit or patch
calls. They're read from its transcript, so files a shell command changed aren't listed. The chip turns amber with ⚠
when another live agent edited one of the same files in the same checkout. Click it for the list, newest first: when,
in which turn, and **unconfirmed** where the transcript never said whether the edit worked. **This turn** narrows it.

Each file can open, or show its diff. As each turn starts, Patchbay records a snapshot of the checkout with git, through
a temporary copy of the index into its own object folder, so your index, branches, stash and repository aren't
touched. Untracked files over 1 MB are left out of it. **This turn** diffs from the latest
turn's snapshot, and **Session** from the turn that first edited the file. Other agents' changes to the same file in
that time show too. A folder outside git has the list but no diff.

Agents can list the same with `patchbay files [--node ID] [--turn]`, for themselves or a node they opened or are linked to.

## Keys

`Ctrl+K` opens the command palette, which searches every action and open session. Settings > Keyboard shortcuts rebinds
any action, warns about conflicts, and resets one or all.

With a terminal in use, it gets ordinary keys, including Ctrl combinations. Patchbay takes only keys with Ctrl+Shift or
Alt, function keys, `Ctrl+K`, `Ctrl+,`, and keys you bind yourself after a warning. `Ctrl+C`, `Ctrl+V` and `Ctrl+F` stay
with the terminal and can't be rebound. So `Ctrl+Z` and `Ctrl+Y` undo only when a terminal doesn't have the keyboard. Esc on the canvas goes back from a
header zoom (double-click a node's header bar).

## Search and handoffs

**Search** (Ctrl+Shift+S, or Search conversations and notes in the palette) finds words in every agent conversation
Patchbay knows, in every project, closed conversations included, in notes, and in the messages agents sent each other.
Filter by project, by date and by kind. Each result says its project. Click it to go to the window or note, or to read a
closed conversation at the message that matched, with Reopen. Every word has to be in one message; put a phrase in quotes to keep it together.

- The index is built in a background thread and kept up to date as transcripts grow. Searching never waits for it:
  while it's still reading, results say they may be incomplete and fill in. It reads only what was added, and
  waits for a line still being written. **Rebuild index** reads everything again. Transcripts are only ever read.
- It holds what Patchbay still knows: open windows, the closed history, notes and the last 300 messages. A deleted
  project's closed conversations stay findable under its old name. A transcript deleted from disk drops out.
- Agents can't use it. Search is the person's alone, and links still decide what an agent can read.

**Continue with another agent** (on a conversation in the results, or an agent window's right-click menu) prepares a
handoff from the conversation: objective, decisions, changed files, verification, remaining work and sources. It's
extracted from the transcript and git, with no AI call, and says so. What it can't find is marked `[Missing: …]` and
what may be out of date `[Stale: …]`, such as a test that ran before later edits, a file that's gone, or an agent
still working. Edit any of it, choose Claude Code or Codex, the folder and a title, and start the agent with it.
Copy as Markdown copies the whole handoff.

## Projects and undo

- **Closing a project** takes it off the tabs, keeps its windows, and leaves its sessions running. Reopen it from
  Recently closed projects in the sidebar, the File menu or the palette. A session waiting on you still shows under
  Status. Clicking it reopens the project.
- **Moving a tab**: drag it along the top bar, use Move left or Move right on its right-click menu, or press
  Alt+Shift+Left/Right with the tab focused. The order is saved, and Ctrl+Z puts it back.
- **Archiving a project** stops its sessions, run commands, browser pages and armed triggers, and takes it off the tabs
  and the closed list. It keeps every node, note, whiteboard, the board and the layout. Agents keep their saved
  conversations and resume when started again. It asks first, listing what stops, and can also clear the project's
  saved terminal output and its pages' site data. Agents can't reach or start its nodes until it's unarchived.
- **Projects** (View or File menu, a tab's menu, or the palette) lists every project, open, closed and archived, with
  its folder, nodes, sessions, when it was last active and its saved output. Sort by any column. Open, close, archive,
  unarchive, rename or delete from there. It can flag projects unused for 14 to 90 days (off by default); nothing is
  archived by itself.
- **Storage**: a project takes little room. Its saved terminal output is at most 1 MB per terminal or run node, and
  its layout is a few KB in `canvas.json`. Browser data and its cache are shared by every project, and Projects can
  clear the cache. Agents' conversations are kept by Claude Code and Codex in their own folders, not by Patchbay.
- **Deleting a project** is separate and permanent, and asks first, naming what it ends.
- **Undo and redo** cover moving, resizing, grouping, tidying, renaming, and adding or deleting notes and groups, one
  history per project, until the app closes. They never start or end a process, so closing a session isn't undoable.
- **Tidy** (dock, View menu, canvas menu, or right-click a group) first shows dashed outlines where each node would
  go. Pick the whole project, the selection or the group, and turn on Needs you first to put agents waiting on you,
  then working ones, at the top left. Apply is one undo step; Esc cancels. Tidy keeps cabled nodes together (a lead
  beside its team, a trigger beside its target), moves groups whole, never overlaps anything, and running it again
  changes nothing. Agents can run `patchbay arrange --layout tidy`.
- **Spawn a team**, on the canvas menu, opens one lead Claude with your task. The lead splits it up with `patchbay
  spawn-team`, then collects and reconciles the results.

## Usage, run commands and ports

- **Usage:** the title bar shows your Claude plan limits, and each Claude window shows how full its context is.
- **Run commands:** add one from the canvas menu for a command you run repeatedly. It has Run, Stop and Restart, and never starts by itself.
- **Run configurations:** New run configuration… reads a folder's `.vscode\launch.json` (comments and trailing commas
  are fine) and lists each configuration and compound. Reading it runs nothing. Only `node` launch configurations run,
  with their `program`, `args`, `cwd`, `env`, `runtimeExecutable`, `runtimeArgs`, `windows` section and variables such
  as `${workspaceFolder}` and `${env:NAME}`. Debugger-only fields are left out and listed. Anything else is shown
  disabled with the reason, including `preLaunchTask` (Patchbay doesn't run VS Code tasks), `envFile`, attach
  configurations and editor variables like `${file}`. A compound opens a group with one run node per configuration,
  each with its own Run, Stop and Restart. launch.json is read again at every Run, and a configuration that can no
  longer run as written is refused with the reason. A small launcher (`resources\launch-run.cjs`, which needs `node` on
  PATH) runs it with no shell in between, from a plan in `launch\` in the data folder.
- **Open ports:** the ports a session is serving show on its sidebar row. Click one to open it in a browser node or in your own browser.

## Triggers

A trigger sends a prompt to one terminal or Claude window on a schedule: every so many seconds, minutes or hours (at
least 5 seconds), a five-field cron expression in local time, or once at a set time. Add one with New trigger… on the
canvas menu, the File menu or the palette. Drag from its jack to a terminal or Claude window to choose where it sends,
or pick one in its form. The moving cable shows where it goes.

- **Arming:** a new trigger is disarmed. Arm… shows the exact schedule, its next runs, the target and the prompt, and
  arms exactly that. Any change to the schedule, prompt or target disarms it again, however it was made. No `patchbay`
  command can arm one. Agents can see triggers in `patchbay list`, without their prompts.
- **Delivery:** a terminal gets the prompt typed straight in, only if it's running. A Claude window gets it only when
  idle, through the same queue as `patchbay send`, and a trigger holds one waiting prompt at most. Disarming or editing
  drops what's waiting. A target that isn't running is a missed run: a trigger never starts a session.
- **Held at a limit:** a prompt for a Claude window stopped at its usage limit waits until the limit resets, then goes
  out. Its run says "Held" and until when.
- **Runs:** Run now fires an armed trigger at once. The node shows the next run time and its last 20 runs as
  Delivered, Waiting, Missed or Failed, with the reason.
- **While closed:** schedules run in the app, so nothing fires while it's closed, even though sessions keep running.
  On the next launch the slots that passed are recorded as one missed run and skipped, with no catch-up. A slot more
  than a minute late, as after sleep, is skipped the same way. A one-off disarms itself once it has run.
- **Cron:** minute, hour, day of month, month and day of week, with `*`, lists, ranges, steps and names like `mon-fri`
  or `jan`. When clocks go forward, a time inside the skipped hour doesn't run that day. When they go back, a time
  inside the repeated hour runs twice.
- A trigger in a closed project keeps running, as its sessions do.

### Event triggers

A trigger can also fire when something happens, instead of at a time. Pick it under When:

- **An agent…** finishes a turn, needs you, or exits.
- **A run node…** finishes, or only when it fails (a non-zero exit). A run you stopped doesn't count.
- **Files change…** in a folder inside the project, matching a pattern such as `**/*.ts`. Changes are gathered until
  there's a quiet spell (5 seconds by default), then fire once. `.git` and `node_modules` are never watched. A pattern
  without `/` matches file names at any depth.

Arming, editing and delivery work as above. Only events that happen while the app is open and the trigger is armed
count. Deleting the node it watches disarms it.

- **Placeholders:** the prompt can use `{{node}}`, `{{event}}`, `{{exitCode}}`, `{{files}}`, `{{folder}}` and
  `{{time}}`, as the kind has them. The form lists them, and arming refuses any the kind doesn't have. `\{{` writes a
  literal `{{`. Values go in in one pass. Typed into a terminal, a value keeps only letters, digits, spaces and
  `. _ / \ : , @ + = -`, so a file name can't run anything in the shell; `{{files}}` gives one argument per file, and
  a name starting with `-` gets `./` in front. Sent to Claude, each file name is in backticks, marked as a name. A
  schedule trigger sends its prompt exactly as written.
- **Limits:** at most once every 30 seconds and 10 times an hour by default; both are in the form. A firing that's held
  back is recorded as Skipped with the reason, and the same skip in a row is shown once with a count.
- **No loops:** when a trigger sends to the agent it watches, or a file trigger sends to a Claude window, what happens
  during the turn its own prompt started doesn't fire it again. A file trigger that types into a terminal ignores
  changes while that terminal keeps printing, plus the quiet time (at least 30 seconds, at most 10 minutes). Arming is
  refused if it would close a loop with armed triggers, such as one sending A's turns to B and another sending B's
  turns to A; the refusal names each trigger. A file trigger counts every session working in its folder.
- **Only if this succeeds:** any trigger can run a command first, such as `npm test`, in a folder inside the project.
  It runs without a shell, so no quotes, pipes or `&&`; name a script instead. It fires only if the command exits 0.
  The exit code and the end of the output go in the run history. A check that runs longer than 2 minutes is ended
  and counts as failed. Run now skips the check and the limits, since it's you asking.

## Links

Opened, Starts after and Trigger cables go one way, so they carry an arrowhead and dots moving toward the far end.
Linked cables give both ends the same access, so they stay still. The dots pause while the view moves and when zoomed
far out, and stop for anyone who has asked Windows for less motion. View > Link legend explains the cables.

## Notes

Add one from the canvas menu or with Ctrl+Shift+N. A note is markdown, shown formatted.

- **Writing.** Double-click a note, or press its pencil, to edit. The toolbar has bold, italic, a heading, lists, a
  checklist, a quote, a link and inline code, and **Code block**, which asks for a language: JSON, JavaScript,
  TypeScript, Python, Shell, PowerShell, HTML, CSS, SQL, YAML, Diff or plain text. Ctrl+B, Ctrl+I, Ctrl+E and Tab work as
  you'd expect, Ctrl+Enter saves and Esc cancels.
- **Reading.** Code blocks are colored for their language and have a Copy button, in notes and in an agent's chat view.
  Checklist boxes can be ticked right on the note. Each note has a title and one of six colors.
- **Agents** make notes with `patchbay sticky` and add to any note linked to them with `patchbay note --append`. They
  can only replace the text of notes they made themselves. A note an agent changed says which one did it, with
  **Undo** and **Keep**.

## Reader

A reader shows a Markdown file, such as an agent's plan, as a document you can read and comment on. It never changes
the file.

- **Opening.** **Open plan in Reader** on an agent's menu opens its latest plan (Claude Code's plan mode keeps plans in
  `~/.claude/plans`), or its latest long answer if it has no plan. Click a `.md` path in a terminal and choose **Open in
  Reader**, drop a file on the canvas, or use **Open document…** in the canvas menu or palette. Agents show you a file
  with `patchbay open-doc --path plan.md`.
- **Reading.** Headings, lists, tables, task boxes and colored code, with an **Outline** to jump through and an arrow on
  each heading to fold its section. **Paper** gives a light page. When the file changes on disk the reader follows it,
  keeps your place and says when it changed.
- **Comments.** Select words and press **Comment**, or press the **+** beside a paragraph or heading, or comment on the
  whole document. A comment keeps the words it's on, so it finds them again after edits, and says **Outdated** when
  they're gone. Comments are kept per file in app data, so closing the reader doesn't lose them.
- **Sending.** **Send** puts every open comment you haven't sent into one message, each with its section and quote,
  and sends it to the agent you pick: the one the document came from comes first. It waits while the agent is busy or
  you're typing to it. Resolve or reopen comments as the agent works; a reopened or edited comment goes again with the
  next send. An agent linked to the reader can also read the comments with `patchbay read`.
- Readers open `.md`, `.markdown`, `.mdx` and `.txt` files on this PC's drives, up to 4 MB, but not network
  shares or files under Windows or Program Files. Links to the web open in your browser, and links to other Markdown
  files open in another reader.

## Whiteboards

Add one from the canvas menu or with Ctrl+Shift+D.

- **Drawing.** Pen, eraser, line, arrow, rectangle, ellipse and text, in six colors and three sizes. Shift keeps lines to
  45 degrees and boxes and ellipses even. The board has its own undo and redo, with Ctrl+Z and Ctrl+Y while it has the
  keyboard.
- **Select** (V) picks shapes by clicking or dragging a box around them. Drag or use the arrow keys to move them, drag
  the corner handle to stretch them (pictures keep their shape, and Shift keeps anything even), press Delete to remove
  them, and click a color or size to restyle them. Double-click text to change it.
- **Fill** gives boxes and ellipses a light tint of their color, for new ones and for any selected.
- **Copy and paste.** Ctrl+C, Ctrl+X and Ctrl+V copy shapes through the clipboard, onto the same board or another one.
  Ctrl+D copies them in place.
- **Screenshots.** Select the board and press Ctrl+V, or drop an image file on it. Pictures are kept in app data, not
  in the canvas file.
- **Agents** linked to a board export it with `patchbay whiteboard` and look at the PNG, pictures and drawing included.
  They can draw diagrams on it with `patchbay draw`, from boxes and the arrows between them; the board shows which agent
  drew, with **Undo** and **Keep**. **Copy as image**, in the board's header, puts it on your clipboard.

## Files on the canvas, and the Files shelf

- **File icons.** Drag files from File Explorer onto the canvas: each becomes an icon, like one on a desktop, that
  points at the file and never copies it. **Pin to canvas** in a terminal's path menu, or on the shelf, does the same.
  Double-click opens a file with its default app. A program or script (`.exe`, `.cmd`, `.bat`, `.ps1`, `.lnk` and the
  like) is only shown in File Explorer. Right-click for Reveal in File Explorer, Copy path, Send path to agent and
  Remove from canvas.
- **Use a file again.** Drag its icon onto a terminal or agent window to type its path there, quoted for that shell.
  Dropping files from File Explorer straight onto a window does the same. **Send path to agent** sends it as a message.
  An agent linked to an icon by a cable can `patchbay read` it, which gives the path, not the contents.
- **Missing files** show dimmed and marked Missing, never as an error. They're looked at again when shown and when
  Patchbay gets focus.
- **Files shelf.** View > Files shelf…, the palette, or **Files** in the title bar. Every file shared in the project,
  newest first, with where it came from: pictures pasted into windows, files dropped onto the canvas or a window, file
  icons, documents opened in a Reader, and browser evidence pictures. Search by name or folder, and filter by type. Each has Open, Reveal, Copy path,
  Pin to canvas, Send path to agent and Forget. Forgetting leaves the file alone.
- **Network paths** (`\\server\share`) work for files you drop yourself. An agent can't pin one.

## Agents working together

Every Claude and Codex window runs with the Patchbay skill, which teaches it the `patchbay` command.

Agents run below normal priority, and so does everything they start. When the PC is short of CPU, the window and your
terminals go first, so typing stays quick however many agents are busy; with CPU to spare, agents run at full speed.

- **Knowing where it is.** An agent is told at the start of its session which node it is, who opened it, and what it can
  reach, and `patchbay whoami` tells it again. Codex is pointed at `whoami` instead.
- **Teams.** **Spawn a team** in the canvas menu, or `patchbay spawn-team`, starts a lead that splits the task, writes each member a
  brief, waits for them with `patchbay wait`, checks their work and closes them. A team's group header shows a light per
  agent and how many are working, idle or need you, with the team's latest message.
- **Messages.** `patchbay send` between agents starts with a line naming the sender, so an agent can tell a lead from a
  peer, and from you. A pulse runs down the cable as a message goes, and clicking a cable lists the latest messages
  along it, kept across restarts.
- **What agents may do.** They read and message only nodes they opened or that you linked to them, stay in their own
  project, and can't answer a permission prompt. Patchbay lets them read its own skill and exports, and run the
  `patchbay` verbs that only look, without asking you; anything that changes or sends something still asks.
- **Claude's own messages between sessions are off.** Claude Code can find and message any other Claude session on
  the PC by itself, around the rule above. In Patchbay's Claude windows it's off: they refuse messages from other
  sessions (`crossSessionInbound: "refuse"`) and can't list them (`ListAgents` is denied). Subagents and teams inside
  one window still talk to each other. Settings > Agents > Claude's own messages, or `"claudeNativeMessaging": "on"`,
  turns it back on for new and restarted windows, and Claude's own rules and yours then apply.
- **Each node speaks for itself.** Hooks and the `patchbay` tool know their node from its environment. Codex nodes start
  with `--no-daemon`, so a shared Codex server can't run one node's hooks with another's environment, and Patchbay
  refuses a hook that names another node's session.
- **Usage limits.** A message or trigger prompt for an agent stopped at its usage limit waits until the limit
  resets, then goes out by itself, even if Patchbay restarted meanwhile (messages queued before a restart are lost, as
  ever). A short rate limit that names no reset is tried again after a minute, then longer. You can still type to it any
  time. After a login or billing failure, messages wait until you've sorted it out. `patchbay list` and `patchbay wait` say which agents stopped and why. Settings >
  Sessions > **Continue after a usage limit resets** (off by default) sends "continue" once at the reset to an agent
  still stopped there with nothing waiting for it. Its badge says so beforehand.
- **Leads keep their team going.** `patchbay restart --node <id>` brings back an agent the lead opened that has
  exited, resuming its conversation, as Restart does. `patchbay link --from <a> --to <b>` links two agents the lead
  opened, so a reviewer can send its findings to the author directly.
- **An agent waiting on you shows it.** An agent stopped at a question before it starts, such as Claude's or Codex's
  question about trusting a new folder, shows needs-you, so the agent that opened it can tell you which node.
- **Long briefs and diagrams** can be piped in: `--prompt-file -`, `--members-file -` and `--diagram-file -` read a
  heredoc, so an apostrophe in a brief never breaks the command and no file is left behind. `patchbay <verb> --help`
  shows one verb's flags.

`test/acceptance/skill-real.cjs` and `team-real.cjs` run real Claude windows through these and read their transcripts,
and `real-world.cjs` gives seven of them everyday jobs on one canvas, including handing a review to Codex. They spend a
little quota.

## Recipes

A recipe is a saved setup of nodes: agents with their prompts, run commands, notes, browsers, how they're laid out and
linked, and setup steps that run before the agents start.

- **New from recipe…**, in the canvas menu, File menu and palette, lists the recipes with where each comes from:
  built-in, personal (in Patchbay's data folder, `recipes`) or the repository's own (`.patchbay\recipes`). Choosing one
  only reads it. The preview shows every node it will make, filled in with your task and branch, and every command that
  runs when you press Start.
- **Start** makes a group, on a new worktree unless you turn that off, with fresh sessions. Two starts never share a
  node. Without a worktree the preview warns that the agents share one checkout, which nothing locks.
- **Setup steps** are a program and its arguments, run with no shell, so nothing is quoted twice. Agents that wait for
  setup stay queued until every step exits with code 0, show which step they wait for, and don't start if one fails.
  Run the step again to retry, or press **Start anyway**.
- **Save selection as recipe…** saves the selected nodes, with folders made relative and the branch made a parameter.
  Sessions, conversations and output are never saved.
- The built-in **Implement and review** has a Claude implementer, a Codex reviewer that starts after it, a setup step,
  a test command and a shared brief. Agents use `patchbay recipes` and `patchbay run-recipe`, but only you can start
  a repository's own recipe.
- **Start runs what the preview showed.** A recipe file changed since is refused. A task or branch with characters a
  shell acts on is refused where the recipe puts it into a terminal or run command, and SSH terminals are listed
  with what runs.

The design is in `docs/plans/recipes.md`.

## Comparing two approaches

**Try another approach…** (canvas menu, an agent's menu, palette) gives one brief to two attempts, each with its own
agent (Claude Code or Codex, any mix), an optional approach line, and its own new worktree and branch. Both start
from the commit shown in the dialog, which is recorded.

- If the checkout has uncommitted changes, the dialog lists them, and you must tick to leave them out before Start.
  They're never copied into an attempt, and never touched.
- **Comparisons…** (palette) shows the attempts side by side: baseline, branch, folder, the agent's status, commits
  since the baseline, and the changed files in two lists, committed and uncommitted. Click a file for its diff.
  Looking only reads git.
- An optional verification command (an argument list, no shell) runs in each worktree when you ask, one at a time.
  Each result keeps the command, exit code, time, the commit it ran at and its output, and says when the attempt has
  changed since.
- **Choose A** or **B** only records the choice. Merge the branch yourself with Git.
- **Remove worktree…** stops the sessions in it. Uncommitted changes, or (when also deleting the branch) commits no
  other branch has, are listed and need a second confirmation for that removal.

The design is in `docs/plans/compare.md`.

## Browser nodes

Add one from the canvas menu, the File menu or the palette. It has back, forward, reload and an address bar, and reopens
its page on the next launch.

- **Only the web.** It opens `http`, `https` and `about:blank`. Files, `javascript:` and links that would start another
  program are refused, and the node says so. A pop-up opens in the same node. Downloads, and requests for the camera,
  microphone, location or notifications, are refused.
- **Its own storage.** Browser nodes you open share one store of sign-ins, and those an agent opens share another, so an
  agent opening its own browser is never signed in as you. Neither is your Chrome or the app window.
- **Pages are walled off.** A page has no preload, no Node, and no route to the app, its control endpoint or its secret.
- **Agents** drive a browser node they opened, or one you linked to them, with `patchbay open-browser` and `patchbay
  browser navigate|back|forward|reload|read|click|type|scroll|screenshot`. The node shows which agent is driving and what
  it did, never what it typed. Agents can't type into password, code or card fields.
- **Recorded checks.** `patchbay browser verify --phase start|step|finish` records an attempt: the URL, viewport,
  actions, a picture at each phase, and console errors and failed requests with the page and time. `browser viewport
  --preset desktop|mobile` sets the page size first, and finish, Take control or `--preset node` set it back. The
  node's **Checks** panel (hidden until there's one) shows each attempt and which agent made it, marks missing pictures and cut-short logs, and
  labels the agent's passed or failed as its claim, not proof. Only the agent that started an attempt can finish it.
  One left alone for 10 minutes is marked abandoned. With `--task-id`, the task's card lists the attempt too, and it
  never makes the task ready. Console text, headers, request bodies and typed text are never kept, and evidence
  pictures hide what's typed in fields.
- **Take control**, on the node or in its right-click menu, refuses every agent verb on it until you press Hand back. It
  stays taken after a restart.
- A page only runs while its project is on screen. Switching projects reloads it when you come back. An agent can still
  click, type and take pictures in a browser that's scrolled out of view on the canvas.
- The address a page moves to is saved with the canvas, including anything in it, such as a search a form puts there.

`test/acceptance/browser.cjs` and `browser-offscreen.cjs` check all of this on the real app against pages they serve
themselves on loopback, and spend no quota.

## Git panel

`Ctrl+Shift+H`, the branch button on the dock, **View > Git panel**, the palette, or **Open in Git panel** on a session's
or worktree group's right-click menu. It works on the system `git`, in one repository at a time: the list at the top
offers the project's folder, its worktree groups and its sessions' folders, with what's selected first.

- **Changes:** staged, unstaged and untracked files with git's status letters (U is untracked), a diff of the one you
  click, stage and unstage per file or all, and commit with a message.
- **Discard** always asks first, naming the files whose changes are thrown away and the untracked files that are
  deleted. Only files still listed as changed are touched, so a stale list can't delete anything else.
- **Branches:** switch, create and switch, or check out a remote-only branch. With uncommitted changes, switching warns
  first. It never forces: if git would overwrite your work, it refuses and the panel shows why.
- **Fetch, Pull and Push** show git's own output and errors. Pull is fast-forward only; if the branches have split, it
  offers a merge. The first push of a new branch sets its upstream on `origin`. Nothing ever asks for a password: git runs
  with terminal prompts and credential pop-ups off, so a sign-in problem fails and says so. Set up a credential helper or
  SSH key in a terminal.
- **History** draws the newest 300 commits of every branch, with merges as lanes.
- Each git call has a time limit and an output limit, and none goes through a shell. The panel refreshes when it opens,
  after its own actions, and when the window comes back into focus, at most every 2 seconds.

## Review inbox

**View > Review inbox…**, the palette, or **Review inbox** on the board's task outcomes. It lists tasks an agent has
submitted with `patchbay task submit`, ready or not yet ready, newest first.

- Each task shows its brief, its checkout (folder, branch, HEAD), the **agent's report** (written by the agent, not
  checked), and the **command runs Patchbay recorded** for its declared checks: passed, failed, not run or stale, with
  the reason. **CI is unavailable**: Patchbay doesn't read CI yet, and that is never shown as a pass.
- When other agents work in the same checkout, or several are assigned, it says the changes are the checkout's, not any
  one agent's.
- **Branch vs base** lists what's committed since the merge-base with the base branch you choose (`main` by default),
  and separately what's only local: uncommitted and untracked files. The header names the base commit and the
  merge-base. **Since last review** compares with a snapshot recorded when you pressed **Mark reviewed** or **Request
  fixes**, never with a time.
- **+** on a diff line adds a comment. Comments are saved, with the file, side, revision and the code around the line.
  When the code moves, the comment follows and says where from; when the line changes or goes, it's marked outdated.
  You resolve comments yourself; an agent's reply doesn't.
- **Request fixes** sends every unresolved comment to an agent assigned to the task, through the same queue as
  `patchbay send`: a busy agent gets it when it's idle. **Accept** is the board's own acceptance, only for you.
- What's recorded as reviewed is what you were looking at, not the files at the moment you click. If they changed after
  you loaded them, it says so, and those changes show under **Since last review**.
- Snapshots go to Patchbay's own store (`review-objects\`), never into the repository: no objects, commits, refs or
  index changes there.
- With unresolved comments, or fixes requested after the latest submission, **Accept** asks first.
- Browser checks an agent recorded show beside the command runs, as the agent's claim.

## Board

`Ctrl+Shift+B`, the board button on the dock, **View > Board view** or the palette. It shows the project's sessions as
cards in columns; Esc or × goes back to the canvas.

- **Dragging a card** changes only its column. The session isn't touched. Clicking a session card goes to it on the
  canvas.
- **Columns** start as To do, In progress, Review and Done. Add one at the end, rename it (double-click or ✎), move it
  with the arrows, or remove it: its cards move to the column beside it, and it says so first. Where cards sit is saved
  with the project.
- **GitHub issues** (tick it, per project) show as their own cards, read with the GitHub CLI (`gh`) you've signed in
  to. Patchbay stores no token. The repository comes from the folder's `origin` on github.com, or the box beside the
  tick. The All, Sessions and Issues tabs filter the cards.
- **A column marked ▶** (In progress, to start with) starts work: dropping an issue there shows the exact prompt a new
  Claude session would get, optionally in a new worktree group, and opens it only if you press Start. The issue's text is
  fenced in the prompt as untrusted, and Claude is told not to follow instructions in it.
- **Writing to GitHub** (close, reopen, comment) only happens from a button on an issue card and a confirm that says what
  will be written. Labels can't be changed from here yet.
- Agents get `patchbay issues` and `patchbay prs`, which only read. There's no verb that writes to GitHub.

`test/acceptance/workbench.cjs` checks the panel against a throwaway repository with a local bare remote, and the board
with a stand-in `gh` (`test/acceptance/fake-gh.cjs`, chosen with `PATCHBAY_GH`). It spends no quota.
