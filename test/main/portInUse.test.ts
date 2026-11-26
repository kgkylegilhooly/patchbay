import { expect, test } from 'vitest'
import { createPortInUseWatch, portInUseIn } from '../../src/main/portInUse'
import { portStripText } from '../../src/shared/portInUse'

// F68: a dev server that fails because its port is taken left the person hunting for the window already serving it.
test.each([
  ['Node', 'Error: listen EADDRINUSE: address already in use :::3000', 3000],
  ['Node on an address', 'Error: listen EADDRINUSE: address already in use 127.0.0.1:5173', 5173],
  ['Vite, strict', 'error when starting dev server:\nError: Port 5173 is already in use', 5173],
  ['Go', 'listen tcp :8080: bind: address already in use', 8080],
  ['.NET', 'Failed to bind to address http://127.0.0.1:5000: address already in use.', 5000],
  ['Windows', 'OSError: [WinError 10048] Only one usage of each socket address (protocol/network address/port) is normally permitted', null],
  ['Python, no port', 'OSError: [Errno 98] Address already in use', null]
])('%s: the error is found, with its port when it says one', (_name, text, port) => {
  expect(portInUseIn(text)).toEqual({ port })
})

test("output that merely mentions a port, or Vite moving to another one by itself, isn't the error", () => {
  expect(portInUseIn('  ➜  Local:   http://localhost:5173/')).toBeNull()
  expect(portInUseIn('Port 5173 is in use, trying another one...')).toBeNull()
  expect(portInUseIn('Listening on :3000')).toBeNull()
})

test('the watch reports once per start, finds an error split across chunks and through colours, and starts over on reset', () => {
  const found: Array<[string, number | null]> = []
  const w = createPortInUseWatch({ found: (id, port) => void found.push([id, port]) })
  w.output('r', 'Error: listen EADDR')
  w.output('r', 'INUSE: address already in use \x1b[1m:::3000\x1b[22m\r\n')
  w.output('r', 'Error: listen EADDRINUSE: address already in use :::3000\r\n')
  expect(found).toEqual([['r', 3000]])
  w.reset('r')
  w.output('r', 'listen tcp :8080: bind: address already in use\n')
  expect(found).toEqual([
    ['r', 3000],
    ['r', 8080]
  ])
})

test('the strip names the window that serves the port, or says another program does', () => {
  expect(portStripText(3000, 'Site server')).toBe('Port 3000 is in use by Site server.')
  expect(portStripText(3000, null)).toBe('Port 3000 is in use by another program, not a window here.')
  expect(portStripText(null, null)).toBe('The address is already in use: another program holds the port this needs.')
})

test("the holder is another window that serves the port; the failing window itself and other ports don't count", async () => {
  const { holderOf } = await import('../../src/shared/portInUse')
  const ports = { self: [{ port: 3000, name: 'node.exe' }], site: [{ port: 3000, name: 'node.exe' }], api: [{ port: 8080, name: 'node.exe' }] }
  expect(holderOf(ports, 3000, 'self')).toBe('site')
  expect(holderOf(ports, 5173, 'self')).toBeNull()
  expect(holderOf(ports, null, 'self')).toBeNull()
  expect(holderOf({ self: [{ port: 3000, name: 'node.exe' }] }, 3000, 'self')).toBeNull()
})
