/**
 * YouTube Music artwork URLs carry their size in the URL. Asking for the size we will
 * actually draw keeps lists light and the full player sharp.
 */
export function thumbnailAt(url: string | undefined, size: number): string | undefined {
  if (!url) return undefined
  // Account avatars come back protocol-relative ("//yt3.ggpht.com/…").
  if (url.startsWith('//')) url = `https:${url}`
  const px = Math.round(size)

  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    if (/=w\d+-h\d+/.test(url)) return url.replace(/=w\d+-h\d+/, `=w${px}-h${px}`)
    if (/=s\d+/.test(url)) return url.replace(/=s\d+/, `=s${px}`)
    if (!url.includes('=')) return `${url}=w${px}-h${px}-l90-rj`
    return url
  }

  // i.ytimg.com video stills: pick a variant big enough for the target size.
  if (/i\.ytimg\.com\/vi\//.test(url)) {
    const variant = px > 480 ? 'maxresdefault' : px > 320 ? 'sddefault' : px > 180 ? 'hqdefault' : 'mqdefault'
    return url.replace(/\/[a-z0-9_]+\.(jpg|webp)(\?.*)?$/i, `/${variant}.jpg`)
  }

  return url
}

/** Pick the largest thumbnail from a list. */
export function largest(thumbnails: { url: string; width: number }[] | undefined): string | undefined {
  if (!thumbnails || thumbnails.length === 0) return undefined
  let best = thumbnails[0]
  for (const thumb of thumbnails) if (thumb.width > best.width) best = thumb
  return best.url.startsWith('//') ? `https:${best.url}` : best.url
}
