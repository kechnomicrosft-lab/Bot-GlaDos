import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const extensions = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif'],
])
const maxBytes = 5 * 1024 * 1024

export async function withDiscordImages(attachments, callback) {
  const images = [...attachments.values()].filter((attachment) => attachment.contentType?.startsWith('image/'))
  if (!images.length) return callback([])
  const supported = images.filter((image) => extensions.has(image.contentType) && image.size <= maxBytes).slice(0, 2)
  if (!supported.length) throw new Error('UnsupportedDiscordImage')

  const directory = await mkdtemp('/media/glados-discord-')
  try {
    const files = []
    for (const attachment of supported) {
      const url = new URL(attachment.url)
      if (url.protocol !== 'https:' || url.host !== 'cdn.discordapp.com' || !url.pathname.startsWith('/attachments/')) {
        throw new Error('InvalidDiscordImageUrl')
      }
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) })
      const mime = response.headers.get('content-type')?.split(';')[0]
      if (!response.ok || mime !== attachment.contentType || !response.body) {
        await response.body?.cancel()
        throw new Error('InvalidDiscordImage')
      }
      const chunks = []
      let length = 0
      for await (const chunk of response.body) {
        length += chunk.length
        if (length > maxBytes) throw new Error('DiscordImageTooLarge')
        chunks.push(chunk)
      }
      if (!length) throw new Error('InvalidDiscordImage')
      const filename = files.length + '.' + extensions.get(mime)
      await writeFile(join(directory, filename), Buffer.concat(chunks), { flag: 'wx' })
      files.push({
        media_content_id: 'media-source://media_source/local/' + basename(directory) + '/' + filename,
        media_content_type: mime,
      })
    }
    return await callback(files)
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => console.error('Nettoyage des images Discord impossible.'))
  }
}
