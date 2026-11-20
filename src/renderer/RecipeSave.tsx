import { useMemo, useState } from 'react'
import { recipeFromSelection, RecipeError, type SavedRecipe } from '../shared/recipe'
import { recipes } from './recipeBridge'
import { useStore } from './store'

/**
 * Saves the selected nodes as a recipe: what each is, where it sits, its prompt and its connections. It shows what
 * will be saved and what's left out before anything is written, and never saves sessions or anything live.
 */
export function RecipeSave({ projectId, selected, onDone, onCancel }: { projectId: string; selected: string[]; onDone: (file: string) => void; onCancel: () => void }): React.JSX.Element {
  const doc = useStore((s) => s.doc)!
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [where, setWhere] = useState<'personal' | 'repository'>('personal')
  const [setupIds, setSetupIds] = useState<string[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [exists, setExists] = useState(false)
  const [busy, setBusy] = useState(false)
  const [secretsChecked, setSecretsChecked] = useState(false)

  // The folder saved folders are made relative to: a selected worktree group's, or the project's.
  const base = useMemo(() => {
    const tops = doc.nodes.filter((n) => selected.includes(n.id) && (!n.parentId || !selected.includes(n.parentId)))
    const group = tops.length === 1 && tops[0].kind === 'group' ? tops[0] : null
    const project = doc.projects.find((p) => p.id === projectId)
    return { cwd: group?.worktree?.path ?? project?.folder ?? '', branch: group?.worktree?.branch }
  }, [doc, selected, projectId])

  const saved = useMemo((): SavedRecipe | { error: string } => {
    try {
      return recipeFromSelection(doc.nodes, doc.edges, selected, { name: name.trim() || 'Untitled recipe', description, cwd: base.cwd, branch: base.branch, setupIds })
    } catch (e) {
      if (e instanceof RecipeError) return { error: e.message }
      throw e
    }
  }, [doc, selected, name, description, base, setupIds])

  // The selection with what's inside its groups, as the recipe takes it.
  const runNodes = useMemo(() => {
    const inside = new Set(selected)
    for (let grew = true; grew; ) {
      grew = false
      for (const n of doc.nodes) if (n.parentId && inside.has(n.parentId) && !inside.has(n.id)) grew = !!inside.add(n.id)
    }
    return doc.nodes.filter((n) => inside.has(n.id) && n.kind === 'run' && !n.launch)
  }, [doc, selected])
  // A repository recipe is shared with everyone who gets the repository, so text that looks secret needs a yes first.
  const blockedBySecrets = 'secrets' in saved && saved.secrets.length > 0 && where === 'repository' && !secretsChecked
  const save = async (overwrite: boolean): Promise<void> => {
    if (!('recipe' in saved) || !name.trim() || blockedBySecrets) return
    setBusy(true)
    setProblem(null)
    const r = await recipes.save({ projectId, recipe: saved.recipe, where, overwrite })
    setBusy(false)
    if (r.ok) return onDone(r.file)
    setExists(!!r.exists)
    setProblem(r.reason)
  }

  return (
    <form
      className="pop recipe-save"
      aria-label="Save selection as recipe"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        void save(false)
      }}
    >
      <h2>Save as recipe</h2>
      <label className="field">
        <span className="field-label">Recipe name</span>
        <input autoFocus value={name} placeholder="Implement and review" onChange={(e) => (setName(e.target.value), setExists(false))} />
      </label>
      <label className="field">
        <span className="field-label">Description</span>
        <input value={description} placeholder="What it sets up" onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="field">
        <span className="field-label">Save to</span>
        <label className="recipe-check">
          <input type="radio" name="recipe-where" checked={where === 'personal'} onChange={() => setWhere('personal')} />
          <span>Personal, for you on this PC</span>
        </label>
        <label className="recipe-check">
          <input type="radio" name="recipe-where" checked={where === 'repository'} onChange={() => setWhere('repository')} />
          <span>This repository, in .patchbay\recipes, to commit and share</span>
        </label>
      </div>
      {'error' in saved ? (
        <p className="field-problem">{saved.error}</p>
      ) : (
        <>
          <section aria-label="What is saved">
            <h3>
              Saves {saved.recipe.nodes.length} node{saved.recipe.nodes.length === 1 ? '' : 's'}
            </h3>
            <ul className="recipe-nodes recipe-nodes-compact">
              {saved.recipe.nodes.map((n) => (
                <li key={n.key} className="recipe-node">
                  <span className="recipe-node-kind">{n.kind === 'agent' ? (n.agent === 'codex' ? 'Codex' : 'Claude Code') : n.kind === 'setup' ? 'Setup step' : n.kind}</span>
                  <span className="recipe-node-title">{n.title}</span>
                  {'folder' in n && n.folder && <code className="recipe-node-cwd">{n.folder}</code>}
                </li>
              ))}
            </ul>
            {base.cwd && (
              <p className="recipe-dim">
                Folders inside <code>{base.cwd}</code> are saved relative to it{base.branch ? <>, and the branch {base.branch} is saved as a parameter</> : null}. Session ids, conversations and output are never saved.
              </p>
            )}
          </section>
          {runNodes.length > 0 && (
            <section aria-label="Setup steps">
              <h3>Setup steps</h3>
              <p className="recipe-dim">A setup step runs when the recipe starts, and agents wait for it to succeed.</p>
              {runNodes.map((n) => (
                <label key={n.id} className="recipe-check">
                  <input type="checkbox" checked={setupIds.includes(n.id)} onChange={(e) => setSetupIds((s) => (e.target.checked ? [...s, n.id] : s.filter((x) => x !== n.id)))} />
                  <span>{n.title}</span>
                </label>
              ))}
              {saved.notSetup.map((s) => (
                <p key={s.title} className="field-problem">
                  {s.title}: {s.why}
                </p>
              ))}
            </section>
          )}
          {saved.skipped.length > 0 && (
            <p className="recipe-dim">
              Left out: {saved.skipped.map((s) => `${s.title} (${s.why})`).join(' ')}
            </p>
          )}
          {saved.outside.length > 0 && (
            <p className="recipe-warning" data-recipe-outside>
              Names nodes outside the selection: {saved.outside.map((o) => `${o.names} in "${o.title}"`).join(', ')}. Agents started from this
              recipe would reach those same nodes, not new ones. Select them too, or edit the text first.
            </p>
          )}
          {saved.secrets.length > 0 && (
            <div className="recipe-warning" data-recipe-secrets>
              <p>
                This may hold secrets: {saved.secrets.map((s) => `${s.what} in "${s.title}"`).join(', ')}. A recipe keeps text as it
                is{where === 'repository' ? ', and one in the repository is shared with whoever gets it' : ''}.
              </p>
              {where === 'repository' && (
                <label className="recipe-check">
                  <input type="checkbox" checked={secretsChecked} onChange={(e) => setSecretsChecked(e.target.checked)} />
                  <span>I've checked: save it to the repository anyway</span>
                </label>
              )}
            </div>
          )}
        </>
      )}
      {problem && <p className="field-problem" role="alert">{problem}</p>}
      <div className="pop-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        {exists ? (
          <button type="button" className="btn btn-danger" disabled={busy || blockedBySecrets} onClick={() => void save(true)}>
            Replace it
          </button>
        ) : (
          <button className="btn btn-solid" disabled={busy || !name.trim() || 'error' in saved || blockedBySecrets}>
            Save recipe
          </button>
        )}
      </div>
    </form>
  )
}
