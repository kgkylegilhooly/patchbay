import { expect, test } from 'vitest'
import { approveAllMessage, sameRequests } from '../../src/renderer/approveAll'
import type { PendingApproval } from '../../src/shared/contract'

/** `same` stands for main's key of the whole input (approvals.ts requestKey): here, the detail is the whole input. */
const ask = (nodeId: string, tool: string, detail: string, summary = detail): PendingApproval => ({ nodeId, requestId: `r-${nodeId}`, tool, summary, detail, same: `${tool}:${detail}` })

// F45: five agents waiting to run the same command need one decision, not five clicks.
test('only requests for the same tool with the same whole detail count; a matching first line is not enough', () => {
  const mine = ask('a', 'Bash', 'npm test')
  const all = [
    mine,
    ask('b', 'Bash', 'npm test'),
    ask('c', 'Bash', 'npm test -- --watch'),
    ask('d', 'PowerShell', 'npm test'),
    ask('e', 'Bash', 'npm test\nrm -rf build', 'npm test'),
    ask('f', 'Bash', 'npm test')
  ]
  expect(sameRequests(all, mine).map((a) => a.nodeId)).toEqual(['a', 'b', 'f'])
  expect(sameRequests([mine], mine)).toEqual([mine])
})

test('the confirmation names the request and every window it approves in', () => {
  expect(approveAllMessage('Bash', 'npm test', ['Parser', 'Docs', 'API'])).toBe('Approves Bash: npm test in Parser, Docs and API, as Approve in each window would.')
})
