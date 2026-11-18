import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../../core/persist/atomicFile'
import { readRecipe, recipeFileName, type Recipe, type RecipeEntry, type RecipeSource } from '../../shared/recipe'
import { BUILT_IN_RECIPES } from '../../shared/recipeBuiltins'

/** Where a repository keeps its recipes, from its root. */
export const REPO_RECIPES = join('.patchbay', 'recipes')
/** At most this many files are read from one folder. */
const MAX_FILES = 100

/** Reads every recipe in a folder. Reading runs nothing. A file that can't be used is listed with the reason. */
export function readRecipeFolder(dir: string, source: Exclude<RecipeSource, 'built-in'>): RecipeEntry[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort().slice(0, MAX_FILES)
  } catch {
    return []
  }
  return files.map((f): RecipeEntry => {
    const file = join(dir, f)
    try {
      const recipe = readRecipe(JSON.parse(readFileSync(file, 'utf8')))
      return { ref: `${source}:${recipe.name}`, source, name: recipe.name, ...(recipe.description ? { description: recipe.description } : {}), file, recipe }
    } catch (e) {
      return { ref: `${source}:${f}`, source, name: f.replace(/\.json$/i, ''), file, problem: (e as Error).message }
    }
  })
}

const ORDER: Record<RecipeSource, number> = { repository: 0, personal: 1, 'built-in': 2 }

/**
 * Every recipe from the three sources, each labelled with where it came from. Nothing is merged. Listed in order of
 * precedence: the repository's, then personal ones, then built-in.
 */
export function listRecipes(personalDir: string, repoRoot: string | null): RecipeEntry[] {
  const builtIn = BUILT_IN_RECIPES.map((recipe): RecipeEntry => ({ ref: `built-in:${recipe.name}`, source: 'built-in', name: recipe.name, description: recipe.description, recipe }))
  const entries = [...(repoRoot ? readRecipeFolder(join(repoRoot, REPO_RECIPES), 'repository') : []), ...readRecipeFolder(personalDir, 'personal'), ...builtIn]
  return entries.sort((a, b) => ORDER[a.source] - ORDER[b.source])
}

/**
 * Finds a recipe by `source:name`, or by name alone, when the first in precedence order wins. Names compare without
 * case. A recipe that can't be read is refused with its reason.
 */
export function findRecipe(entries: RecipeEntry[], ref: string): { ok: true; entry: RecipeEntry } | { ok: false; problem: string } {
  const exact = entries.find((e) => e.ref.toLowerCase() === ref.toLowerCase())
  const byName = entries.filter((e) => e.name.toLowerCase() === ref.toLowerCase())
  const hit = exact ?? byName.find((e) => e.recipe) ?? byName[0]
  if (!hit) return { ok: false, problem: `There's no recipe called "${ref}". Run patchbay recipes to see them.` }
  if (!hit.recipe) return { ok: false, problem: `The recipe "${hit.name}" can't be used: ${hit.problem}` }
  return { ok: true, entry: hit }
}

/** Saves a recipe as a file, refusing to replace one unless asked. */
export async function saveRecipeFile(dir: string, recipe: Recipe, overwrite: boolean): Promise<{ ok: true; file: string } | { ok: false; reason: string; exists?: boolean }> {
  const file = join(dir, recipeFileName(recipe.name))
  if (!overwrite && existsSync(file)) return { ok: false, reason: `There's already a recipe file ${file}.`, exists: true }
  mkdirSync(dir, { recursive: true })
  await writeAtomic(file, `${JSON.stringify(recipe, null, 2)}\n`)
  return { ok: true, file }
}
