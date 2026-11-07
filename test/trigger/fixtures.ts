import type { TriggerNode } from '../../src/shared/model'

export const triggerNode = (id: string, over: Partial<TriggerNode> = {}): TriggerNode => ({
  id,
  kind: 'trigger',
  title: id,
  x: 0,
  y: 0,
  width: 320,
  height: 260,
  parentId: null,
  schedule: { type: 'interval', everyMs: 60_000 },
  prompt: 'check the build',
  targetId: 't',
  armedSpec: null,
  armedAt: null,
  nextAt: null,
  runs: [],
  ...over
})
