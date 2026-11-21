'use strict'
// A second app on a throwaway profile's session host, for docs/plans/session-sync.md. Connecting knocks the real app
// off, as a second app would, and what it starts runs in the host behind that app's back. The app reconnects a moment
// later and has to find it. Only ever used on a profile a test made: it needs that profile's host key.
const { createHash, createHmac, randomBytes } = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

/** As pipeNameFor in src/main/sessions/hostProtocol.ts. */
function pipeFor(profile) {
  const key = createHash('sha256').update(path.resolve(profile).toLowerCase()).digest('hex').slice(0, 24)
  return `\\\\.\\pipe\\patchbay-host-${key}`
}

const frame = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

/** An idle cmd.exe in the host, as `nodeId`. */
function idleShell(nodeId, cwd) {
  const keep = ['SystemRoot', 'SYSTEMROOT', 'PATH', 'Path', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR']
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.includes(k)))
  return { nodeId, file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/k', 'echo started-behind-its-back'], cwd, env }
}

/** Connects, starts each spec, and lets go. Resolves to what each start answered. Throws if knocked off first. */
function startBehindItsBack(profile, specs, timeoutMs = 5000) {
  const secret = fs.readFileSync(path.join(profile, 'control', 'host-secret'), 'utf8').trim()
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeFor(profile))
    const nonce = randomBytes(32).toString('hex')
    const answers = []
    let pending = Buffer.alloc(0)
    let next = 1
    const timer = setTimeout(() => fail(new Error('the host did not answer in time')), timeoutMs)
    const fail = (e) => {
      clearTimeout(timer)
      socket.destroy()
      reject(e)
    }
    const send = (m) => socket.write(frame(m))
    const ask = () => {
      if (answers.length === specs.length) {
        clearTimeout(timer)
        socket.end()
        socket.destroy()
        return resolve(answers)
      }
      send({ t: 'req', id: next++, op: 'start', args: { spec: specs[answers.length] } })
    }
    socket.on('error', fail)
    socket.on('close', () => answers.length < specs.length && fail(new Error('knocked off before it finished')))
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 4 && pending.length - 4 >= pending.readUInt32LE(0)) {
        const size = pending.readUInt32LE(0)
        const message = JSON.parse(pending.subarray(4, 4 + size).toString('utf8'))
        pending = pending.subarray(4 + size)
        if (message.t === 'challenge') {
          const proof = createHmac('sha256', secret).update(`app:${message.nonce}`).digest('hex')
          send({ t: 'hello', proof, nonce, protocol: message.protocol })
        } else if (message.t === 'welcome') {
          ask()
        } else if (message.t === 'res') {
          answers.push(message.ok ? { ok: true } : { ok: false, message: message.message })
          ask()
        }
      }
    })
  })
}

module.exports = { pipeFor, idleShell, startBehindItsBack }
