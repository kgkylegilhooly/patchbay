import { useEffect, useMemo, useRef, useState } from 'react'
import { branchFor, expectedWorktreePath, planRecipe, showArgv, toArgv, type RecipeEntry, type RecipeParams, type RecipePlan } from '../shared/recipe'
import { bridge } from './bridge'
import { shortPath } from './shortPath'
import { recipes } from './recipeBridge'
import { useAgentChoice } from './agentChoice'
import { agentNames } from '../shared/agents'
import { AGENT_NAMES, type AgentKind } from '../shared/model'
import { WorkflowList } from './workflows/WorkflowList'
import { WorkflowPane, useWorkflowShown } from './workflows/WorkflowPane'
import { leaveWorkflows } from './workflows/workflowUi'
import { Panel } from './shell/Panel'

type Listing = { entries: RecipeEntry[]; repo: string | null; folder: string }

const SOURCE_LABEL: Record<RecipeEntry['source'], string> = { 'built-in': 'Built-in', personal: 'Personal', repository: 'Repository' }

/** Shows each new node's id as the recipe key it stands for, since the real ids are only made on Start. */
function readable(text: string, plan: RecipePlan): string {
  return Object.entries(plan.ids).reduce((t, [key, id]) => t.replaceAll(id, `‹${key}›`), text)
}

function kindLabel(plan: RecipePlan, node: RecipePlan['nodes'][number]): string {
  if (plan.setup.some((s) => s.id === node.id)) return 'Setup step'
  switch (node.kind) {
    case 'claude':
      return node.agent === 'codex' ? 'Codex' : 'Claude Code'
    case 'run':
      return 'Run command'
    case 'sticky':
      return 'Note'
    default:
      return node.kind[0].toUpperCase() + node.kind.slice(1)
  }
}

/**
 * Picks a recipe and shows exactly what starting it makes and runs, with the parameters filled in. Opening this, and
 * choosing a recipe, only reads files: nothing runs until Start.
 */
export function RecipePicker({ projectId, onStart, onCancel }: { projectId: string; onStart: (r: { group: string }) => void; onCancel: () => void }): React.JSX.Element {
  const [listing, setListing] = useState<Listing | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [task, setTask] = useState('')
  const [branch, setBranch] = useState('')
  const [branchEdited, setBranchEdited] = useState(false)
  const [worktree, setWorktree] = useState(true)
  const [repo, setRepo] = useState('')
  const [cwd, setCwd] = useState('')
  const [skip, setSkip] = useState<string[]>([])
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // Settings > Agents: agents turned off start as the default instead only when the person ticks it here.
  const agents = useAgentChoice()
  const [useAgent, setUseAgent] = useState<AgentKind | undefined>(undefined)
  const taskRef = useRef<HTMLTextAreaElement>(null)
  // A workflow chosen in the second section takes the right side; see src/renderer/workflows.
  const workflowShown = useWorkflowShown()
  useEffect(() => leaveWorkflows, [])

  useEffect(() => {
    void recipes.list(projectId).then((l) => {
      setListing(l)
      setRepo(l.repo ?? '')
      setCwd(l.folder)
      const first = l.entries.find((e) => e.recipe)
      if (first) setChosen(first.ref)
    })
  }, [projectId])

  const entry = listing?.entries.find((e) => e.ref === chosen)
  const recipe = entry?.recipe
  // A new recipe brings its own defaults, and no edits from the last one.
  useEffect(() => {
    if (!recipe) return
    setWorktree(recipe.worktree !== false && !!listing?.repo)
    setSkip([])
    setEdits({})
    setUseAgent(undefined)
    setProblem(null)
    taskRef.current?.focus()
  }, [recipe, listing?.repo])

  const effectiveBranch = branchEdited ? branch : branchFor(task)
  const runs: Record<string, string[]> = {}
  const badEdits: string[] = []
  for (const [key, text] of Object.entries(edits)) {
    const argv = toArgv(text, true)
    if (argv) runs[key] = argv
    else badEdits.push(key)
  }
  const params: RecipeParams = { task, branch: effectiveBranch, repo, cwd, worktree, skip, runs, ...(useAgent ? { useAgent } : {}) }
  const agentsOff = [...new Set(recipe?.nodes.flatMap((n) => (n.kind === 'agent' && !agents.enabled.includes(n.agent) ? [n.agent] : [])) ?? [])]
  const shownCwd = worktree ? expectedWorktreePath(repo || '…', effectiveBranch || '‹branch›') : cwd
  /** A folder as shown: relative to the working directory, whose full path is shown once above. */
  const where = (folder: string): string => (folder === shownCwd ? (worktree ? 'the new worktree' : 'the working directory') : folder.startsWith(`${shownCwd}\\`) ? folder.slice(shownCwd.length + 1) : folder)
  const plan = useMemo(() => {
    if (!recipe) return null
    let n = 0
    return planRecipe(recipe, { ...params, cwd: shownCwd }, () => `new-node-${++n}-${Math.random().toString(36).slice(2, 8)}`, agents)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, task, effectiveBranch, repo, cwd, worktree, skip.join(','), JSON.stringify(runs), useAgent, agents])

  const setupNodes = recipe?.nodes.filter((n) => n.kind === 'setup') ?? []
  const missing = worktree ? (!effectiveBranch ? 'Enter a branch for the new worktree.' : !repo ? 'Choose the repository.' : null) : !cwd ? 'Choose a working directory.' : null
  const canStart = !!recipe && !busy && !missing && badEdits.length === 0 && !plan?.problems.length

  const start = async (): Promise<void> => {
    if (!entry || !canStart || workflowShown) return
    setBusy(true)
    setProblem(null)
    const r = await recipes.start({ projectId, ref: entry.ref, ...(entry.hash ? { hash: entry.hash } : {}), params })
    setBusy(false)
    if (r.ok) onStart({ group: r.group })
    else setProblem(r.reason)
  }

  return (
    <Panel
      kind="modal"
      title="New from recipe"
      icon="team"
      className="recipe-sheet"
      onClose={onCancel}
      initialFocus="none"
      flush
      onSubmit={(e) => {
        e.preventDefault()
        void start()
      }}
    >
      <div className="recipe-body">
      <div className="recipe-list" role="listbox" aria-label="Recipes">
        <span className="field-label">Recipes</span>
        {!listing && <p className="recipe-dim">Reading recipes…</p>}
        {listing?.entries.map((e) => (
          <button
            type="button"
            key={e.ref}
            role="option"
            aria-selected={e.ref === chosen && !workflowShown}
            className={`recipe-item${e.ref === chosen && !workflowShown ? ' recipe-item-on' : ''}${e.recipe ? '' : ' recipe-item-off'}`}
            data-recipe={e.name}
            onClick={() => (leaveWorkflows(), setChosen(e.ref))}
          >
            <span className="recipe-item-name">{e.name}</span>
            <span className={`recipe-source recipe-source-${e.source}`}>{SOURCE_LABEL[e.source]}</span>
            {e.problem && <span className="recipe-why">{e.problem}</span>}
          </button>
        ))}
        {/* The recipes' folders, in the same one line the workflows below use for theirs. */}
        <p className="workflow-list-foot" data-recipe-files>
          Files:{' '}
          <button type="button" className="workflow-link" title="Open the folder of your own recipes" onClick={() => void recipes.openRecipesFolder(projectId, 'personal')}>
            personal
          </button>
          {listing?.repo && (
            <>
              {' · '}
              <button type="button" className="workflow-link" title="Open this repository's .patchbayecipes folder" onClick={() => void recipes.openRecipesFolder(projectId, 'repository')}>
                repository
              </button>
            </>
          )}
        </p>
        {/* Once the recipes are in, so the workflows below them never move under a click. */}
        {listing && <WorkflowList projectId={projectId} onPick={() => setProblem(null)} />}
      </div>

      {workflowShown ? <WorkflowPane projectId={projectId} onStart={onStart} onCancel={onCancel} /> : <div className="recipe-preview">
        {entry && !recipe && <p className="field-problem">This recipe can't be used: {entry.problem}</p>}
        {recipe && plan && (
          <>
            <header className="recipe-head">
              <h2>{recipe.name}</h2>
              <span className={`recipe-source recipe-source-${entry!.source}`}>{SOURCE_LABEL[entry!.source]}</span>
              {entry!.file && <code className="recipe-file" title={entry!.file}>{entry!.file}</code>}
              {recipe.description && <p className="recipe-dim">{recipe.description}</p>}
            </header>

            <div className="recipe-params">
              <label className="field recipe-wide">
                <span className="field-label">Task</span>
                <textarea ref={taskRef} rows={2} value={task} placeholder="What the agents should do" onChange={(e) => setTask(e.target.value)} />
              </label>
              <label className="recipe-check">
                <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
                <span>Make a new worktree</span>
              </label>
              {worktree ? (
                <>
                  <label className="field">
                    <span className="field-label">Branch</span>
                    <input
                      value={effectiveBranch}
                      spellCheck={false}
                      placeholder="feature-name"
                      onChange={(e) => {
                        setBranchEdited(true)
                        setBranch(e.target.value)
                      }}
                    />
                  </label>
                  <div className="field">
                    <span className="field-label">Repository</span>
                    <div className="folder-row">
                      <span className={repo ? 'folder' : 'folder folder-empty'} title={repo}>
                        {repo ? shortPath(repo) : 'Choose a repository'}
                      </span>
                      <button type="button" className="btn" onClick={() => void bridge.pickFolder().then((f) => f && setRepo(f))}>
                        Choose
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="field recipe-wide">
                  <span className="field-label">Working directory</span>
                  <div className="folder-row">
                    <span className={cwd ? 'folder' : 'folder folder-empty'} title={cwd}>
                      {cwd ? shortPath(cwd) : 'Choose a folder'}
                    </span>
                    <button type="button" className="btn" onClick={() => void bridge.pickFolder().then((f) => f && setCwd(f))}>
                      Choose
                    </button>
                  </div>
                </div>
              )}
            </div>

            {agentsOff.length > 0 && (
              <label className="recipe-use-agent" data-recipe-use-agent>
                <input type="checkbox" checked={!!useAgent} onChange={(e) => setUseAgent(e.target.checked ? agents.default : undefined)} /> Start its {agentNames(agentsOff)} agents with {AGENT_NAMES[agents.default]} instead
              </label>
            )}
            {plan.problems.map((p) => (
              <p key={p} className="field-problem" role="alert" data-recipe-problem>
                {p}
              </p>
            ))}
            {plan.warnings.map((w) => (
              <p key={w} className="recipe-warning" data-recipe-warning>
                {w}
              </p>
            ))}

            <section aria-label="What it makes">
              <h3>
                Creates a group, <q>{plan.frame.title}</q>
                {worktree ? <>, in a new worktree</> : null}
              </h3>
              <p className="recipe-dim recipe-where">
                {worktree ? 'New worktree' : 'Working directory'}: <code>{shownCwd}</code>
              </p>
              <ul className="recipe-nodes">
                {plan.nodes.map((n) => {
                  const key = Object.entries(plan.ids).find(([, id]) => id === n.id)?.[0] ?? ''
                  const hold = plan.holds[n.id]
                  const after = hold?.after.length ? hold.after : plan.after[n.id]
                  const afterNames = (after ?? []).map((id) => plan.nodes.find((m) => m.id === id)?.title ?? id).join(', ')
                  return (
                    <li key={n.id} className="recipe-node" data-recipe-node={key}>
                      <span className="recipe-node-kind">{kindLabel(plan, n)}</span>
                      <span className="recipe-node-title">{n.title}</span>
                      {'cwd' in n && <code className="recipe-node-cwd">{where(n.cwd)}</code>}
                      {(hold || afterNames) && (
                        <span className="recipe-node-wait">
                          {hold ? 'Waits for setup' : ''}
                          {hold && afterNames ? ', then starts after ' : afterNames ? 'Starts after ' : ''}
                          {afterNames}
                        </span>
                      )}
                      {n.kind === 'claude' && n.prompt && (
                        <details className="recipe-prompt">
                          <summary>Prompt</summary>
                          <pre>{readable(n.prompt, plan)}</pre>
                        </details>
                      )}
                      {n.kind === 'sticky' && n.text && (
                        <details className="recipe-prompt">
                          <summary>Text</summary>
                          <pre>{readable(n.text, plan)}</pre>
                        </details>
                      )}
                    </li>
                  )
                })}
              </ul>
              {plan.edges.some((e) => e.kind === 'link') && (
                <p className="recipe-dim">
                  Linked:{' '}
                  {plan.edges
                    .filter((e) => e.kind === 'link')
                    .map((e) => `${plan.nodes.find((n) => n.id === e.from)?.title} ↔ ${plan.nodes.find((n) => n.id === e.to)?.title}`)
                    .join(', ')}
                </p>
              )}
            </section>

            <section aria-label="What runs on Start">
              <h3>Runs when you press Start</h3>
              {setupNodes.length === 0 && plan.runs.length === 0 && <p className="recipe-dim">Nothing but the agents themselves.</p>}
              <ul className="recipe-runs">
                {setupNodes.map((n) => {
                  const off = skip.includes(n.key)
                  const planned = plan.setup.find((s) => s.key === n.key)
                  return (
                    <li key={n.key} className={`recipe-run${off ? ' recipe-run-off' : ''}`} data-setup-step={n.key}>
                      <label className="recipe-check">
                        <input type="checkbox" checked={!off} onChange={(e) => setSkip((s) => (e.target.checked ? s.filter((k) => k !== n.key) : [...s, n.key]))} />
                        <span>{n.title}</span>
                      </label>
                      <input
                        className="recipe-argv"
                        aria-label={`Command for ${n.title}`}
                        spellCheck={false}
                        disabled={off}
                        value={edits[n.key] ?? showArgv(n.run)}
                        onChange={(e) => setEdits((x) => ({ ...x, [n.key]: e.target.value }))}
                      />
                      {badEdits.includes(n.key) && <span className="field-problem">Setup steps run with no shell. Use plain words, without quotes, &&, | or redirection. For shell syntax, name the shell, as in cmd /d /c, in the recipe file.</span>}
                      <span className="recipe-run-how">
                        No shell, in <code>{where(planned?.cwd ?? shownCwd)}</code>. Agents that wait for setup start when it exits with code 0.
                      </span>
                    </li>
                  )
                })}
                {plan.runs
                  .filter((r) => r.how !== 'no shell')
                  .map((r) => (
                    <li key={r.title + r.what} className="recipe-run">
                      <span>{r.title}</span>
                      <code className="recipe-argv">{r.what}</code>
                      <span className="recipe-run-how">
                        {r.how === 'ssh' ? 'Connects with ssh from this PC, as soon as it starts.' : <>In your shell, in <code>{where(r.cwd)}</code>.</>}
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="recipe-dim">Run commands in the recipe only run when you click their Run button.</p>
            </section>
          </>
        )}
        {problem && <p className="field-problem" role="alert">{problem}</p>}
        {!problem && missing && <p className="recipe-dim">{missing}</p>}
        <div className="pop-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-solid" disabled={!canStart} data-recipe-start>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>}
      </div>
    </Panel>
  )
}
