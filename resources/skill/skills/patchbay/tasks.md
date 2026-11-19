# Task outcomes

Tasks are project records, separate from agent status. Idle does not mean done.

```sh
patchbay task create --brief "Fix login" --criteria "Invalid tokens are rejected" --cwd C:/Code/app --sessions ID --checks '[{"id":"unit","command":"npm test"}]'
patchbay task list
patchbay task state --task ID --state running
patchbay task verify --task ID --check unit
patchbay task submit --task ID --summary "Fixed token validation; please review."
patchbay task show --task ID
```

`create` accepts `--depends-on ID,ID`. Required checks are JSON objects with an id,
command and optional cwd (the task's cwd by default). Repeat `--criteria` for more
criteria; comma-separated values are also accepted. `--sessions` defaults to you.
Use `--sessions=` for an unassigned task. IDs refer to canvas sessions, not provider
conversation IDs. A session can belong to several tasks.

`verify` actually runs the command in the native system shell, in its recorded cwd.
It returns a running attempt immediately. Use `show` later for its exit status and
saved output file. An extra check can specify `--check NAME --command CMD --cwd DIR`.
Required checks must match their declared command and cwd. Every retry is a new
attempt; an older pass cannot hide a newer failure. Runs have a ten-minute limit
and an eight-megabyte output limit; exceeding either records failure.

`submit` records an agent self-report, never a passing check or human acceptance.
The person reviews and accepts on the board. Missing, failed, interrupted or stale
checks prevent acceptance. Git revision, uncommitted state and Git-visible content
must still match. Unknown Git identity blocks review; ignored files are outside the
fingerprint. Refresh evidence before accepting after edits. Historical acceptance
remains visible even when later code changes make its evidence stale.

Working states are planned, running, blocked and cancelled. `state running` reopens
accepted work while keeping earlier submissions and decisions. Cancelled tasks are
final. Restarting preserves history and marks unfinished checks interrupted, without
rerunning them. Dependencies require accepted upstream tasks with current evidence;
missing upstream tasks block. These records do not launch sessions or change `--after`.
