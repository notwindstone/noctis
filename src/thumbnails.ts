import { services } from './services/registry'

/**
 * Artwork at the size it will be drawn. Services that encode sizes in their URLs
 * provide `thumbnails.resize` (YouTube Music does); others' URLs are used as they are.
 */
export function thumbnailAt(url: string | undefined, size: number): string | undefined {
  if (!url) return undefined
  // Some avatars come back protocol-relative ("//yt3.ggpht.com/…").
  if (url.startsWith('//')) url = `https:${url}`
  const px = Math.round(size)
  for (const id in services) {
    const resized = services[id].thumbnails?.resize(url, px)
    if (resized) return resized
  }
  return url
}
