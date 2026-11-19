# Task outcomes

Tasks are project records, separate from agent status. Idle does not mean done.

```sh
patchbay task create --brief "Fix login" --criteria "Invalid tokens are rejected" --cwd C:/Code/app --sessions ID --checks '[{"id":"unit","command":"npm test"}]'
patchbay task list
patchbay task list --readiness   # each task's attempts, and whether it is ready now
patchbay task state --task ID --state running
patchbay task verify --task ID --check unit
patchbay task submit --task ID --summary "Fixed token validation; please review."
patchbay task show --task ID
```

`create` accepts `--depends-on ID,ID`. Required checks are JSON objects with an id,
command and optional cwd (the task's cwd by default). Repeat `--criteria` for more
criteria; each one is taken whole, commas included. `--sessions` defaults to you.
Use `--sessions=` for an unassigned task. IDs refer to canvas sessions, not provider
conversation IDs. A session can belong to several tasks.

`verify` runs a check declared at `create`, exactly as declared: no other command or
folder can be given. It runs in cmd.exe (not Git Bash), in Patchbay itself, so outside
your own sandbox; the person sees each declared command on the board, marked as
declared by you. Write checks for cmd. It returns a running attempt immediately. Use
`show` later for its exit status and saved output file. Every retry is a new
attempt; an older pass cannot hide a newer failure. Runs have a ten-minute limit
and an eight-megabyte output limit; exceeding either records failure.

`submit` records an agent self-report, never a passing check or human acceptance.
The person reviews and accepts on the board. Missing, failed, interrupted or stale
checks prevent acceptance. Git revision, uncommitted state and Git-visible content
must still match. Unknown Git identity blocks review, with the reason; ignored files
are outside the fingerprint. A folder outside any git repository can be accepted, with
a warning that changes since can't be detected. A check that changes the files it
checks (writing untracked, non-ignored files) is never fresh: commit or ignore them. Refresh evidence before accepting after edits. Historical acceptance
remains visible even when later code changes make its evidence stale.

Working states are planned, running, blocked and cancelled. `state running` reopens
accepted work while keeping earlier submissions and decisions. Cancelled tasks are
final. Restarting preserves history and marks unfinished checks interrupted, without
rerunning them. Dependencies require accepted upstream tasks with current evidence;
missing upstream tasks block. These records do not launch sessions or change `--after`.
