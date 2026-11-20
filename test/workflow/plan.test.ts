import { describe, expect, test } from 'vitest'
import { downstreamOf, executionOrder, findCycles, usesOf } from '../../src/core/workflow/plan'
import type { WorkflowDefinition } from '../../src/shared/workflow'
import { featureWorkflow } from './fixtures'

const step = (id: string, after: string[] = []) => ({ id, name: id, action: 'human-review', inputs: { question: { from: 'const' as const, value: '?' } }, after })
const dag = (...jobs: ReturnType<typeof step>[]): WorkflowDefinition => ({ schema: 1, id: 'w', name: 'W', inputs: [], jobs })

describe('dependency planning', () => {
  test('outline order when it already respects dependencies', () => {
    expect(executionOrder(featureWorkflow())).toEqual(['plan', 'approve', 'implement', 'tests', 'review'])
  })

  test('dependencies first, otherwise outline order', () => {
    expect(executionOrder(dag(step('c', ['a']), step('b'), step('a')))).toEqual(['b', 'a', 'c'])
  })

  test('no order for a cycle, and the cycle is found', () => {
    const d = dag(step('a', ['b']), step('b', ['a']), step('c'))
    expect(executionOrder(d)).toBeNull()
    expect(findCycles(d)).toEqual([['a', 'b', 'a']])
  })

  test('dangling dependencies don\'t break planning', () => {
    expect(executionOrder(dag(step('a', ['ghost'])))).toEqual(['a'])
  })

  test('downstream jobs are found through data and wait-for', () => {
    expect(downstreamOf(featureWorkflow(), 'approve')).toEqual(['implement', 'tests', 'review'])
    expect(downstreamOf(featureWorkflow(), 'tests')).toEqual(['review'])
    expect(downstreamOf(featureWorkflow(), 'review')).toEqual([])
  })

  test('uses of an output: the affected jobs before it is deleted', () => {
    expect(usesOf(featureWorkflow(), 'plan', 'plan')).toEqual([{ jobId: 'approve', param: 'material' }, { jobId: 'implement', param: 'instructions' }])
    expect(usesOf(featureWorkflow(), 'review')).toEqual([{ workflowOutput: 'review' }])
    expect(usesOf(featureWorkflow(), 'tests')).toEqual([]) // Review only waits for it.
  })
})
