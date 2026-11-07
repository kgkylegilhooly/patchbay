import { describe, expect, test } from 'vitest'
import { isSshHost, sshHostProblem, sshHosts } from '../../src/core/ssh/config'

describe('sshHosts', () => {
  test('lists each named host once, in the order written', () => {
    const text = ['Host build-box', '  HostName 10.0.0.1', '', 'Host web1 web2', '  Port 2222', 'host build-box'].join('\n')
    expect(sshHosts(text)).toEqual(['build-box', 'web1', 'web2'])
  })

  test('leaves out patterns and negations, which are not hosts to connect to', () => {
    expect(sshHosts('Host * !skip *.corp web?\nHost real')).toEqual(['real'])
  })

  test('reads Host=name, tabs, quotes, comments and Windows line endings', () => {
    expect(sshHosts('# Host commented\r\nHost=one\r\n\tHost\t"two"\r\nHost three # note\r\n')).toEqual(['one', 'two', 'three'])
  })

  test('ignores Host inside other words and Match blocks', () => {
    expect(sshHosts('HostName nothere\nMatch host x\nHostKeyAlias y\nHost ok')).toEqual(['ok'])
  })

  test('skips names ssh would read as options', () => {
    expect(sshHosts('Host -oProxyCommand=calc fine')).toEqual(['fine'])
  })

  test('an empty or missing file has no hosts', () => {
    expect(sshHosts('')).toEqual([])
  })
})

describe('isSshHost', () => {
  test.each(['build-box', 'web1.example.com', 'me@host', 'me@10.0.0.1', 'host_2', 'fe80::1'])('accepts %s', (h) => {
    expect(isSshHost(h)).toBe(true)
  })

  test.each(['', ' ', '-oProxyCommand=calc', '-p', 'a b', 'host;calc', 'host&calc', 'a|b', '"q"', 'x\n', '@host', 'a'.repeat(256)])('refuses %j', (h) => {
    expect(isSshHost(h)).toBe(false)
  })

  test('says why a host was refused', () => {
    expect(sshHostProblem('')).toBe('Type a host.')
    expect(sshHostProblem('-oProxyCommand=calc')).toMatch(/isn’t a host name/)
    expect(sshHostProblem('ok')).toBeNull()
  })
})
