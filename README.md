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
| `Partitions\patchbay-browser*\` | Browser node storage: sign-ins and site data, apart from your own browser |
| `browser-shots\` | Screenshots agents took of browser nodes, the newest 50 |
| `agent-edits.json` | Agents' changes to notes and whiteboards that you haven't kept or undone yet |
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
them another shell in `settings.json` (below), and press Restart.

`settings.json` can set the shell for new terminals and the permission mode for Claude nodes:

```json
{ "shell": "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "permissionMode": "default" }
```

`codexApproval` sets what Codex nodes may do without asking. `never` keeps Codex's sandbox but never asks: anything the
sandbox blocks comes back to Codex as a failure. `bypass` asks nothing and runs commands without the sandbox, so use it
only in folders you trust. Leave it out to keep Codex's own default. It's also under Settings > Agents.

```json
{ "codexApproval": "never" }
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
- **Status** sorts every session by what it's doing: Need attention, Unread, Running, Idle and Unknown. Only a session
  whose Claude hooks said so is ever Idle. Queued and starting sessions go under Starting, ended ones under Stopped,
  and terminals and run commands, which can't report a status, under Terminals and commands. Each session appears once.
  A closed project's sessions stay out of this list unless they need you or have something to look at.
- **Last activity** is held in memory, so after a restart a session shows no time until it next does something.
- **Pin:** pinned, the sidebar stays open. Unpinned, clicking the canvas hides it.
- **Recently closed** reopens a closed Claude conversation, the same as Recent conversations.

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
- **Deleting a project** is separate and permanent, and asks first, naming what it ends.
- **Undo and redo** cover moving, resizing, grouping, tidying, renaming, and adding or deleting notes and groups, one
  history per project, until the app closes. They never start or end a process, so closing a session isn't undoable.
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
- **Runs:** Run now fires an armed trigger at once. The node shows the next run time and its last 20 runs as
  Delivered, Waiting, Missed or Failed, with the reason.
- **While closed:** schedules run in the app, so nothing fires while it's closed, even though sessions keep running.
  On the next launch the slots that passed are recorded as one missed run and skipped, with no catch-up. A slot more
  than a minute late, as after sleep, is skipped the same way. A one-off disarms itself once it has run.
- **Cron:** minute, hour, day of month, month and day of week, with `*`, lists, ranges, steps and names like `mon-fri`
  or `jan`. When clocks go forward, a time inside the skipped hour doesn't run that day. When they go back, a time
  inside the repeated hour runs twice.
- A trigger in a closed project keeps running, as its sessions do.

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
