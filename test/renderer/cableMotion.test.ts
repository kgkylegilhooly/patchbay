import { describe, expect, test } from 'vitest'
import { cableDirection, isFarZoom } from '../../src/renderer/cableMotion'
import { cablePath, toFlow } from '../../src/renderer/flowMapping'
import type { CanvasDoc, CanvasNode, Edge } from '../../src/shared/model'
import { claudeNode, terminalNode } from '../control/fakes'
import { triggerNode } from '../trigger/fixtures'

const doc = (nodes: CanvasNode[], edges: Edge[] = []): CanvasDoc => ({ version: 3, projects: [], activeProjectId: 'p', nodes, edges, closed: [], viewport: { x: 0, y: 0, zoom: 1 } })

describe('which way a cable runs', () => {
  test('opened, after and trigger cables go one way; links go both', () => {
    expect(cableDirection('opened')).toBe('forward')
    expect(cableDirection('after')).toBe('forward')
    expect(cableDirection('trigger')).toBe('forward')
    expect(cableDirection('link')).toBe('both')
  })

  test('the cable starts where the edge does, so the dots travel from opener to opened and from waited-on to waiting', () => {
    const edges: Edge[] = [
      { id: 'o', from: 'opener', to: 'opened', kind: 'opened' },
      { id: 'a', from: 'first', to: 'waits', kind: 'after' }
    ]
    const flow = toFlow(doc([claudeNode('opener'), claudeNode('opened'), claudeNode('first'), claudeNode('waits')], edges), {}).edges
    expect(flow.map((e) => [e.source, e.target])).toEqual([['opener', 'opened'], ['first', 'waits']])
    // The path is drawn from its source jack.
    expect(cablePath(10, 20, 300, 40).path.startsWith('M 10 20')).toBe(true)
  })

  test('one-way cables get an arrowhead at the far end, and links none', () => {
    const edges: Edge[] = [
      { id: 'o', from: 'a', to: 'b', kind: 'opened' },
      { id: 'l', from: 'a', to: 'b', kind: 'link' }
    ]
    const [opened, link] = toFlow(doc([claudeNode('a'), claudeNode('b')], edges), {}).edges
    expect(opened.markerEnd).toMatchObject({ type: 'arrowclosed' })
    expect(link.markerEnd).toBeUndefined()
  })

  test('a trigger with a target draws a cable to it, which is never saved', () => {
    const d = doc([terminalNode('t'), triggerNode('tr', { targetId: 't' }), triggerNode('none', { targetId: null })])
    const flow = toFlow(d, {}).edges
    expect(flow).toEqual([expect.objectContaining({ id: 'trigger:tr', source: 'tr', target: 't', className: 'cable-trigger', selectable: true })])
    expect(d.edges).toEqual([])
  })

  test('no trigger cable is drawn to a target on another project', () => {
    const d = doc([terminalNode('t', { projectId: 'q' }), triggerNode('tr', { projectId: 'p' })])
    expect(toFlow(d, {}).edges).toEqual([])
  })

  test('the dots stop far out', () => {
    expect(isFarZoom(0.2)).toBe(true)
    expect(isFarZoom(0.5)).toBe(false)
  })
})
