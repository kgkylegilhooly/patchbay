import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The abort signal of the `patchbay` call being answered, which fires when the caller's connection closes first, as
 * when the person stops the tool call. It travels with the call through every verb wrapper without each passing it on.
 * A long `wait` uses it to end without taking the reports it would have handed over, so they still arrive.
 */
export const rpcSignal = new AsyncLocalStorage<AbortSignal>()
