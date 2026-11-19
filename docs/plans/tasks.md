# Tasks: first slice

Tasks are project records, independent of process-owning nodes. A task has a brief,
acceptance criteria, zero or more assigned canvas session IDs, an explicit state,
required named commands and optional upstream task IDs. Many sessions may share a
task and a session may have several tasks. Session status never changes task state.

Agents create, list, inspect, change working state, submit and run checks through
`task` verbs. Submission is an immutable self-report attempt; actual commands are
separate verification attempts, with saved output, timestamps, exit status and Git
identity. Retries append attempts. Only the board's Accept action records human
acceptance, against a specific submission. No agent verb accepts a task.

Task data lives on Project as optional `tasks: TaskRecords`; absence means no tasks
and existing version-3 projects need no rewrite. Invalid task records refuse the
save rather than silently losing outcomes. Interrupted verification attempts become
interrupted on load; they never relaunch. Required checks use the newest matching
attempt, never an older passing attempt hidden behind a failure. Git revision,
dirty flag and a content fingerprint (tracked diff, index and untracked files) must
match at execution start, end and review. Unknown Git identity blocks acceptance,
including tasks without required checks. Ignored files are outside that identity.

The board shows tasks, summaries, checks and Accept; associated session cards and
session headers show compact outcomes. Inspection/acceptance refreshes freshness.
Historical acceptance stays recorded even when later code changes make its checks
stale; readiness is reported separately. Dependencies are a distinct task readiness
condition: missing/cancelled/unaccepted upstream tasks block; cycles are refused.
This slice stores/evaluates readiness but launches no dependent sessions. Existing
starts-after semantics and session host behavior are untouched.

Open choices settled: checks are explicit named command/cwd pairs declared at task
creation; no automatic test discovery. Commands run in the native system shell with
hidden windows, bounded runtime and output. Commands may be mutating, like existing
run nodes. Cancellation prevents new attempts but keeps history. No delete verb is
offered; missing upstream IDs still block. Browser evidence can reference task IDs
and attempt IDs without presenting browser actions as command checks. Review inbox,
task launch gates and richer editing remain subsequent work.

Validation: `npm run typecheck` and `npm run build` pass. The task tests cover real
command execution and timeout, authenticated CLI routing, submissions versus human
acceptance, check freshness, failed retries, missing output/dependencies, migration
and interrupted attempts. Full Vitest: 1560 passed, 1 skipped, only the known
`host.test.ts > any other session keeps normal priority` failure. Existing after-gate
tests pass unchanged. The screenshot scenario exercises the Accept button and
refuses forged `setTasks` writes through generic renderer IPC:

```sh
npm run build
node -r ./test/tasks/screenshotScene.cjs screenshot.js docs/acceptance/tasks-board.png --no-build --scene tasks --size 1440x1000
```

The scene uses a throwaway Git repository, a real local `node --version` command,
and stand-in agents. It consumes no real agent quota.
