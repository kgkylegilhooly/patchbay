import { useReactFlow } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { RecipePicker } from './RecipePicker'
import { RecipeSave } from './RecipeSave'
import { closeRecipes, useRecipeUi } from './recipeUi'
import { useStore } from './store'
import './recipes.css'
import { safePadding } from './safeArea'

/** The recipe picker and the save dialog, over the canvas, whichever is open. */
export function RecipeLayer({ selected }: { selected: string[] }): React.JSX.Element | null {
  const picker = useRecipeUi((s) => s.picker)
  const saving = useRecipeUi((s) => s.saving)
  const projectId = useStore((s) => s.doc?.activeProjectId)
  const flow = useReactFlow()
  const [savedTo, setSavedTo] = useState<string | null>(null)

  useEffect(() => {
    if (!savedTo) return
    const t = setTimeout(() => setSavedTo(null), 6000)
    return () => clearTimeout(t)
  }, [savedTo])

  if (!projectId) return null
  return (
    <>
      {picker && (
        <RecipePicker
          projectId={projectId}
          onCancel={closeRecipes}
          onStart={({ group }) => {
            closeRecipes()
            // The new group is drawn once its doc arrives.
            setTimeout(() => void flow.fitView({ nodes: [{ id: group }], padding: safePadding(), maxZoom: 1, duration: 260 }), 300)
          }}
        />
      )}
      {saving && (
        <RecipeSave
          projectId={projectId}
          selected={selected}
          onCancel={closeRecipes}
          onDone={(file) => {
            closeRecipes()
            setSavedTo(file)
          }}
        />
      )}
      {savedTo && (
        <p className="recipe-saved" role="status">
          Recipe saved to <code>{savedTo}</code>
        </p>
      )}
    </>
  )
}
