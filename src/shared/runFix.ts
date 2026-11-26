/** A failed run's brief for a new agent, and the folder it ran in. See src/main/runFix.ts. */
export type RunFixResult = { ok: true; brief: string; cwd: string } | { ok: false; reason: string }
