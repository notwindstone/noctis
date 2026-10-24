/**
 * YouTube Music artwork URLs carry their size in the URL. Asking for the size we will
 * actually draw keeps lists light and the full player sharp. Undefined for URLs that
 * aren't YouTube's.
 */
export function resizeThumbnail(url: string, px: number): string | undefined {
  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    if (/=w\d+-h\d+/.test(url)) return url.replace(/=w\d+-h\d+/, `=w${px}-h${px}`)
    if (/=s\d+/.test(url)) return url.replace(/=s\d+/, `=s${px}`)
    if (!url.includes('=')) return `${url}=w${px}-h${px}-l90-rj`
    return url
  }

  // i.ytimg.com video stills. Artwork is always shown square (center-cropped), so use
  // the 16:9 variants: hqdefault/sddefault are 4:3 with black bars that would show.
  if (/i\.ytimg\.com\/vi\//.test(url)) {
    const variant = px > 180 ? 'hq720' : 'mqdefault'
    return url.replace(/\/[a-z0-9_]+\.(jpg|webp)(\?.*)?$/i, `/${variant}.jpg`)
  }

  return undefined
}

/** Pick the largest thumbnail from a list. */
export function largest(thumbnails: { url: string; width: number }[] | undefined): string | undefined {
  if (!thumbnails || thumbnails.length === 0) return undefined
  let best = thumbnails[0]
  for (const thumb of thumbnails) if (thumb.width > best.width) best = thumb
  return best.url.startsWith('//') ? `https:${best.url}` : best.url
}
