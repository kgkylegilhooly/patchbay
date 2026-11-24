/**
 * What a verb says about a `--group` that isn't there. A team's group goes when its last member closes, and a lead
 * that kept its id then opened agents into nothing, so this says plainly that the group is gone and nothing was made.
 */
export function noGroup(id: string, removed?: { title: string; lastMember: string }): string {
  const why = removed
    ? `it was removed when its last member, "${removed.lastMember}", closed`
    : "it was removed or never existed (a team's group goes when its last member closes)"
  return (
    `Group "${id}" is gone: ${why}. Nothing was created. ` +
    'Leave --group out, or make a new group with patchbay group --ids ID,ID --label L, or see the groups there are with patchbay list.'
  )
}
