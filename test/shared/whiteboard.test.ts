import { describe, expect, test } from 'vitest'
import type { WhiteboardShape } from '../../src/shared/model'
import { boardArea, describeBoard, exportBox, isWhiteboardShape, moveShape, penPath, shapeAt, shapeBox, shapesIn, shapeSvg, thinPoints, touches, whiteboardSvg } from '../../src/shared/whiteboard'

const pen = (points: number[]): WhiteboardShape => ({ type: 'pen', color: '#1f1f22', size: 4, points })

describe('isWhiteboardShape', () => {
  test('accepts every kind of shape', () => {
    expect(isWhiteboardShape(pen([0, 0, 1, 1]))).toBe(true)
    for (const type of ['line', 'arrow', 'rect', 'ellipse']) expect(isWhiteboardShape({ type, color: '#fff', size: 2, x1: 0, y1: 0, x2: 5, y2: 5 })).toBe(true)
    expect(isWhiteboardShape({ type: 'text', color: '#2f6fd6', size: 2, x: 0, y: 0, text: 'hi' })).toBe(true)
  })

  test('refuses anything that could break the SVG or the save file', () => {
    expect(isWhiteboardShape({ ...pen([0, 0]), color: 'red" onload="x' })).toBe(false)
    expect(isWhiteboardShape(pen([0, 0, 1]))).toBe(false)
    expect(isWhiteboardShape(pen([0, Number.NaN]))).toBe(false)
    expect(isWhiteboardShape({ ...pen([0, 0]), size: -1 })).toBe(false)
    expect(isWhiteboardShape({ type: 'text', color: '#000', size: 2, x: 0, y: 0, text: '' })).toBe(false)
    expect(isWhiteboardShape({ type: 'blob', color: '#000', size: 2 })).toBe(false)
    expect(isWhiteboardShape(null)).toBe(false)
  })
})

test('thinPoints drops points too close together, keeping both ends', () => {
  expect(thinPoints([0, 0, 0.2, 0.2, 0.4, 0.4, 5, 5, 5.3, 5.1, 9.99, 9.99])).toEqual([0, 0, 5, 5, 10, 10])
})

test('penPath curves through the middle of each pair of points', () => {
  expect(penPath([0, 0, 10, 0, 10, 10])).toBe('M0 0Q10 0 10 5L10 10')
  expect(penPath([3, 4])).toBe('M3 4l0.01 0')
})

test('text is escaped, so nothing written on a board becomes markup', () => {
  const svg = shapeSvg({ type: 'text', color: '#000', size: 2, x: 0, y: 0, text: '</text><script>x</script>\nline "2"' })
  expect(svg).not.toContain('<script')
  expect(svg).toContain('&lt;/text&gt;&lt;script&gt;')
  expect(svg.match(/<tspan/g)).toHaveLength(2)
})

test('an export takes in shapes drawn past the board edge', () => {
  expect(exportBox([], 300, 200)).toEqual({ x: 0, y: 0, width: 300, height: 200 })
  const box = exportBox([pen([-50, 10, 400, 20])], 300, 200)
  expect(box.x).toBeLessThan(-50)
  expect(box.x + box.width).toBeGreaterThan(400)
  const { svg, width, height } = whiteboardSvg([pen([100, 100, 110, 110])], 300, 200)
  expect([width, height]).toEqual([300, 200])
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="300" height="200" viewBox="0 0 300 200"><rect /)
})

test('the eraser touches a shape only near its ink', () => {
  const rect: WhiteboardShape = { type: 'rect', color: '#000', size: 2, x1: 0, y1: 0, x2: 100, y2: 100 }
  expect(touches(rect, 50, 2, 4)).toBe(true)
  expect(touches(rect, 50, 50, 4)).toBe(false)
  expect(touches(pen([0, 0, 100, 0]), 50, 5, 4)).toBe(true)
  expect(touches(pen([0, 0, 100, 0]), 50, 20, 4)).toBe(false)
  const ellipse: WhiteboardShape = { type: 'ellipse', color: '#000', size: 2, x1: 0, y1: 0, x2: 100, y2: 50 }
  expect(touches(ellipse, 100, 25, 3)).toBe(true)
  expect(touches(ellipse, 50, 25, 3)).toBe(false)
})

describe('selecting and moving', () => {
  const line: WhiteboardShape = { type: 'line', color: '#000', size: 2, x1: 0, y1: 0, x2: 100, y2: 0 }
  const label: WhiteboardShape = { type: 'text', color: '#000', size: 2, x: 200, y: 200, text: 'hi' }
  const stroke = pen([10, 300, 20, 310])

  test('a click picks the topmost shape near its ink, or nothing', () => {
    expect(shapeAt([line, { ...line, color: '#fff' }], 50, 3, 6)).toBe(1)
    expect(shapeAt([line], 50, 40, 6)).toBe(-1)
  })

  test('a drag box picks only the shapes wholly inside it', () => {
    expect(shapesIn([line, label, stroke], { x: -10, y: -10, width: 400, height: 260 })).toEqual([0, 1])
    expect(shapesIn([line, label, stroke], { x: 0, y: 0, width: 50, height: 50 })).toEqual([])
  })

  test('every kind of shape moves by the same amount', () => {
    expect(moveShape(line, 5, -2)).toMatchObject({ x1: 5, y1: -2, x2: 105, y2: -2 })
    expect(moveShape(label, 1.25, 0)).toMatchObject({ x: 201.3, y: 200 })
    expect(moveShape(stroke, 1, 2)).toMatchObject({ points: [11, 302, 21, 312] })
  })
})

test('a board describes itself by its shapes and its words', () => {
  expect(describeBoard([pen([0, 0, 1, 1]), pen([0, 0, 1, 1]), { type: 'text', color: '#000', size: 2, x: 0, y: 0, text: 'API' }])).toEqual({ shapes: { pen: 2, text: 1 }, texts: ['API'] })
})

test('the paper is the node less its header, toolbar and margins', () => {
  expect(boardArea({ width: 640, height: 460 })).toEqual({ width: 626, height: 376 })
})

describe('pictures', () => {
  const file = `${'ab'.repeat(32)}.png`
  const picture: WhiteboardShape = { type: 'image', color: '#000', size: 2, x: 10, y: 20, width: 100, height: 50, file }

  test('a picture names only a file this saves, by its content', () => {
    expect(isWhiteboardShape(picture)).toBe(true)
    for (const bad of ['../secret.png', 'C:\\x.png', `${'ab'.repeat(32)}.exe`, 'abc.png']) expect(isWhiteboardShape({ ...picture, file: bad }), bad).toBe(false)
    expect(isWhiteboardShape({ ...picture, width: 0 })).toBe(false)
  })

  test('it draws from an image data URL, and as a placeholder without one', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo='
    expect(shapeSvg(picture, () => data)).toBe(`<image href="${data}" x="10" y="20" width="100" height="50" preserveAspectRatio="none"/>`)
    expect(shapeSvg(picture)).toMatch(/^<rect x="10" y="20" width="100" height="50"/)
    expect(shapeSvg(picture, () => 'javascript:alert(1)" onload="x')).toMatch(/^<rect /)
  })

  test('it moves, is picked inside its area, and fills its box', () => {
    expect(moveShape(picture, 5, 5)).toMatchObject({ x: 15, y: 25, width: 100 })
    expect(shapeAt([picture], 60, 40, 6)).toBe(0)
    expect(shapeBox(picture)).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    expect(describeBoard([picture]).shapes).toEqual({ image: 1 })
  })
})
