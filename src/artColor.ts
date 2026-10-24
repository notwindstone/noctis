import { rgbToOklch } from './theme'
import { thumbnailAt } from './thumbnails'

const hues = new Map<string, number | null>()

/**
 * The dominant hue of an artwork, in OKLCH degrees, for Material You colours that
 * follow the music. Pixels are weighted by chroma so greys and near-black borders don't
 * wash everything out. Returns null for monochrome art or when the image can't be read.
 */
export async function artworkHue(url: string | undefined): Promise<number | null> {
  if (!url) return null
  const cached = hues.get(url)
  if (cached !== undefined) return cached

  const hue = await new Promise<number | null>((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.referrerPolicy = 'no-referrer'
    image.decoding = 'async'
    image.onload = () => {
      try {
        const size = 24
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return resolve(null)
        context.drawImage(image, 0, 0, size, size)
        const { data } = context.getImageData(0, 0, size, size)

        let x = 0
        let y = 0
        let weight = 0
        for (let i = 0; i < data.length; i += 4) {
          const { chroma, hue, lightness } = rgbToOklch(data[i], data[i + 1], data[i + 2])
          if (lightness < 0.12 || lightness > 0.97) continue
          const w = chroma * chroma
          const radians = (hue * Math.PI) / 180
          x += Math.cos(radians) * w
          y += Math.sin(radians) * w
          weight += w
        }

        if (weight < 0.02) return resolve(null)
        resolve(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360)
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = thumbnailAt(url, 96) ?? url
  })

  hues.set(url, hue)
  return hue
}
