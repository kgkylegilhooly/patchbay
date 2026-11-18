# Recipes on the Patchbay canvas

Part of the Patchbay skill: read SKILL.md first, for what you may touch.

A recipe is a saved setup of nodes: agents with their prompts, run commands, notes, browsers, their layout and the
links between them, and setup steps that run before the agents start. Starting one makes fresh nodes and sessions,
usually in a new worktree.

```sh
patchbay recipes                                   # every recipe, with its source: repository, personal or built-in
patchbay recipes --name "Implement and review" --task "Add dark mode" --branch dark-mode
                                                   # previews what it would make and run; runs nothing
patchbay run-recipe --name "Implement and review" --task "Add dark mode" --branch dark-mode
patchbay run-recipe --name "Implement and review" --task "..." --no-worktree --cwd DIR --skip setup
```

- Preview first, and check `runsOnStart`: those commands run as soon as you start it. Repository recipes come from
  the repository's own files, so read their commands before starting one.
- `--name` alone picks the repository's recipe, then a personal one, then the built-in one. `--source` picks one.
- A new worktree needs a branch that doesn't exist yet. With `--no-worktree` the agents share one checkout, and
  nothing stops them overwriting each other's changes.
- Agents that wait for setup stay queued until every setup step exits with code 0, and don't start if one fails.
  The person sees which step failed and its output. Tell them; don't work around it.
- The nodes are opened by you and linked to you, as with `spawn-team`, so you can `read`, `send` and `wait`.
- Saving a recipe is the person's to do, from the canvas (Save selection as recipe).
