import { expect, test } from 'vitest'
import { linkAttemptToTask, taskRecordOf, taskRefusal } from '../../src/main/browser/taskLink'
import { isAttempt, recoverTasks, sanitizeTasks, taskReadiness, type Task, type TaskRecords } from '../../src/shared/task'
import type { BrowserAttempt } from '../../src/shared/browserEvidence'
import { memoryStore } from '../control/fakes'

const task = (id: string, state: Task['state'] = 'running'): Task => ({
  id, projectId: 'p', brief: 'Check out', acceptanceCriteria: ['Order saves'], assignedSessionIds: [], cwd: 'C:\\work', state,
  requiredChecks: [], dependsOn: [], createdAt: 1, updatedAt: 1, acceptances: []
})

const attempt = (patch: Partial<BrowserAttempt> = {}): BrowserAttempt => ({
  id: 'att-1', nodeId: 'b', projectId: 'p', taskId: 't1', startedBy: { id: 'agent', title: 'Checker' }, startedAt: 10, url: 'https://site.test/checkout',
  viewport: { width: 390, height: 844, preset: 'mobile' }, state: 'recording', assertion: 'unknown',
  revision: { revision: 'abc', uncommitted: false, fingerprint: 'f' }, actions: [], captures: [], diagnostics: [], gaps: [], ...patch
})

function storeWith(records: TaskRecords) {
  const store = memoryStore()
  store.dispatch({ op: 'addProject', project: { id: 'p', name: 'P', folder: 'C:\\work', viewport: { x: 0, y: 0, zoom: 1 } } } as never)
  store.dispatch({ op: 'setTasks', projectId: 'p', tasks: records })
  const records$ = () => store.get().projects.find((p) => p.id === 'p')?.tasks
  return { store, records: records$ }
}

test('--task-id must name a task in the browser\'s project that is not cancelled', () => {
  const { store } = storeWith({ tasks: [task('t1'), task('gone', 'cancelled')], attempts: [] })
  expect(taskRefusal(store.get(), 'p', 't1')).toBeNull()
  expect(taskRefusal(store.get(), 'p', 'typo')).toMatch(/no task "typo".*patchbay task list/)
  expect(taskRefusal(store.get(), 'other', 't1')).toMatch(/no task/)
  expect(taskRefusal(store.get(), 'p', 'gone')).toMatch(/cancelled/)
})

test('the task lists the attempt as it starts, and the same entry is updated as it ends', () => {
  const { store, records } = storeWith({ tasks: [task('t1')], attempts: [] })
  expect(records()).toBeDefined()
  linkAttemptToTask(store, attempt())
  expect(records()!.attempts).toEqual([expect.objectContaining({ kind: 'browser', id: 'browser-att-1', taskId: 't1', state: 'recording', endedAt: null, sessionId: 'agent' })])
  linkAttemptToTask(store, attempt({ state: 'incomplete', assertion: 'passed', finishedAt: 50, gaps: ['Takeover'] }))
  expect(records()!.attempts).toEqual([expect.objectContaining({ state: 'incomplete', assertion: 'passed', endedAt: 50, gaps: 1 })])
})

test('a browser check is a valid task attempt, survives loading, and never makes a task ready', () => {
  const record = taskRecordOf(attempt({ state: 'recorded', assertion: 'passed', finishedAt: 50 }))!
  expect(isAttempt(record)).toBe(true)
  const loaded = sanitizeTasks({ tasks: [task('t1')], attempts: [record] })!
  expect(loaded).toMatchObject({ dropped: 0, records: { attempts: [record] } })
  expect(loaded.records.other).toBeUndefined()
  const readiness = taskReadiness(loaded.records, loaded.records.tasks[0], {})
  expect(readiness.ready).toBe(false)
  expect(readiness.reasons).toContain('No agent submission')
})

test('a browser check still recording when the app stopped is incomplete after it starts again', () => {
  const recording = taskRecordOf(attempt())!
  const recovered = recoverTasks({ tasks: [task('t1')], attempts: [recording] }, 99)
  expect(recovered.attempts[0]).toMatchObject({ kind: 'browser', state: 'incomplete', endedAt: 99, gaps: 1 })
  expect(recovered.tasks[0].state).toBe('running')
})

test('an attempt without a task, or for a task that has gone, changes no task', () => {
  const { store, records } = storeWith({ tasks: [task('t1')], attempts: [] })
  linkAttemptToTask(store, attempt({ taskId: undefined }))
  linkAttemptToTask(store, attempt({ taskId: 'deleted' }))
  expect(records()?.attempts ?? []).toEqual([])
})
