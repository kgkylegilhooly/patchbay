/** Two soft rising notes, made here rather than loaded from a file. */
const NOTES = [
  { hz: 659.25, at: 0, length: 0.22 },
  { hz: 987.77, at: 0.11, length: 0.32 }
]
const VOLUME = 0.16

let context: AudioContext | null = null

export function playChime(): void {
  try {
    context ??= new AudioContext()
    const ctx = context
    void ctx.resume()
    const start = ctx.currentTime + 0.01
    for (const note of NOTES) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = note.hz
      gain.gain.setValueAtTime(0.0001, start + note.at)
      gain.gain.exponentialRampToValueAtTime(VOLUME, start + note.at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start + note.at)
      osc.stop(start + note.at + note.length + 0.02)
    }
    console.debug('patchbay-chime', ctx.state)
  } catch (e) {
    // A missing sound device isn't worth interrupting anyone over.
    console.warn('Patchbay could not play the chime:', e)
  }
}
