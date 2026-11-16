import { describe, expect, test } from 'vitest'
import { layoutDiagram, readDiagram } from '../../src/shared/diagram'
import { isWhiteboardShape, shapeBox } from '../../src/shared/whiteboard'

const spec = readDiagram({
  title: 'Login flow',
  boxes: [{ id: 'web', label: 'Browser' }, { id: 'api', label: 'API' }, { id: 'auth', label: 'Auth service', color: 'red' }, { id: 'db', label: 'Users\ndatabase' }],
  arrows: [{ from: 'web', to: 'api', label: 'POST /login' }, { from: 'api', to: 'auth' }, { from: 'auth', to: 'db', label: 'reads' }, { from: 'api', to: 'db' }]
})

describe('laying out a diagram', () => {
  const shapes = layoutDiagram(spec, [])
  const rect = (label: string) => {
    const i = shapes.findIndex((s) => s.type === 'text' && s.text === label)
    return shapeBox(shapes[i - 1])
  }

  test('every shape is one a board accepts, with a box and a label per box, and an arrow per arrow', () => {
    expect(shapes.every(isWhiteboardShape)).toBe(true)
    expect(shapes.filter((s) => s.type === 'rect')).toHaveLength(4)
    expect(shapes.filter((s) => s.type === 'arrow')).toHaveLength(4)
    expect(shapes.find((s) => s.type === 'text' && s.text === 'Login flow')).toBeTruthy()
  })

  test('arrows run one way: each box sits to the right of what points at it', () => {
    expect(rect('API').x).toBeGreaterThan(rect('Browser').x)
    expect(rect('Auth service').x).toBeGreaterThan(rect('API').x)
    expect(rect('Users\ndatabase').x).toBeGreaterThan(rect('Auth service').x)
  })

  test('boxes don\'t overlap, and a long label makes its box wider', () => {
    const boxes = shapes.filter((s) => s.type === 'rect').map(shapeBox)
    for (const a of boxes) for (const b of boxes) if (a !== b) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true)
    expect(rect('Auth service').width).toBeGreaterThan(rect('API').width)
  })

  test('going down stacks the columns as rows instead', () => {
    const down = layoutDiagram({ ...spec, direction: 'down' }, [])
    const api = down.findIndex((s) => s.type === 'text' && s.text === 'API')
    const web = down.findIndex((s) => s.type === 'text' && s.text === 'Browser')
    expect(shapeBox(down[api - 1]).y).toBeGreaterThan(shapeBox(down[web - 1]).y)
  })

  test('it goes below what is already on the board', () => {
    const existing = [{ type: 'line' as const, color: '#000', size: 2, x1: 0, y1: 0, x2: 10, y2: 300 }]
    expect(Math.min(...layoutDiagram(spec, existing).map((s) => shapeBox(s).y))).toBeGreaterThan(300)
  })

  test('a cycle still lays out, inside the board', () => {
    const loop = layoutDiagram(readDiagram({ boxes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], arrows: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }), [])
    expect(loop.filter((s) => s.type === 'arrow')).toHaveLength(2)
  })
})

describe('reading what an agent sent', () => {
  test('says exactly what is wrong', () => {
    expect(() => readDiagram([])).toThrow(/JSON object/)
    expect(() => readDiagram({ boxes: [] })).toThrow(/at least one box/)
    expect(() => readDiagram({ boxes: [{ id: 'a' }, { id: 'a' }] })).toThrow(/Two boxes have the id "a"/)
    expect(() => readDiagram({ boxes: [{ id: 'a' }], arrows: [{ from: 'a', to: 'nope' }] })).toThrow(/Arrow 1/)
    expect(() => readDiagram({ boxes: [{ id: 'a', color: 'teal' }] })).toThrow(/unknown color/)
    expect(() => readDiagram({ boxes: [{ id: 'a' }], direction: 'up' })).toThrow(/"right" or "down"/)
  })

  test('a box with no label shows its id', () => {
    expect(readDiagram({ boxes: [{ id: 'cache' }] }).boxes[0].label).toBe('cache')
  })
})

test('a request and its response between the same boxes keep the boxes in order, and run side by side', () => {
  // As a real agent described a three-tier app: requests one way, responses back.
  const flow = readDiagram({
    boxes: [{ id: 'browser', label: 'Browser' }, { id: 'web', label: 'Web server' }, { id: 'app', label: 'App server' }, { id: 'db', label: 'Database' }],
    arrows: [
      { from: 'browser', to: 'web', label: '1. Request' }, { from: 'web', to: 'app', label: '2. Call' }, { from: 'app', to: 'db', label: '3. Query' },
      { from: 'db', to: 'app', label: '4. Rows' }, { from: 'app', to: 'web', label: '5. Result' }, { from: 'web', to: 'browser', label: '6. Response' }
    ]
  })
  const shapes = layoutDiagram(flow, [])
  const x = (label: string) => shapeBox(shapes[shapes.findIndex((s) => s.type === 'text' && s.text === label) - 1]).x
  expect(x('Browser')).toBeLessThan(x('Web server'))
  expect(x('Web server')).toBeLessThan(x('App server'))
  expect(x('App server')).toBeLessThan(x('Database'))
  const arrows = shapes.filter((s) => s.type === 'arrow') as Array<{ y1: number; y2: number; x1: number }>
  // The request to the web server and the response from it are apart, not one on top of the other.
  const there = arrows[0]
  const back = arrows[5]
  expect(Math.abs(there.y1 - back.y2)).toBeGreaterThanOrEqual(10)
  // Each label sits clear of the other's.
  const label = (t: string) => shapes.find((s) => s.type === 'text' && s.text === t) as { y: number }
  expect(Math.abs(label('1. Request').y - label('6. Response').y)).toBeGreaterThan(15)
})
