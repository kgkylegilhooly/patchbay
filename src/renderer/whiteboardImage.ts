/** Turns a board's SVG into a PNG in this page, which has the fonts and the canvas to do it. */
export async function svgToPng(svg: string, width: number, height: number, scale = 1): Promise<Blob> {
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const g = canvas.getContext('2d')
  if (!g) throw new Error('No canvas to draw on.')
  g.drawImage(image, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be made.'))), 'image/png'))
}
