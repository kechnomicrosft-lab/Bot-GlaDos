import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const extensions = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif'],
])
const maxBytes = 5 * 1024 * 1024

function detectImageType(bytes) {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

export async function withDiscordImages(attachments, callback) {
  const images = [...attachments.values()].filter((attachment) => attachment.contentType?.startsWith('image/'))
  if (!images.length) return callback([])
  const supported = images.filter((image) => extensions.has(image.contentType) && image.size <= maxBytes).slice(0, 2)
  if (!supported.length) throw new Error('UnsupportedDiscordImage')

  const directory = await mkdtemp('/media/glados-discord-').catch((error) => {
    console.error('Création du dossier média Discord impossible. Code : ' + (error.code ?? 'inconnu'))
    throw error
  })
  try {
    const files = []
    for (const attachment of supported) {
      const url = new URL(attachment.url)
      if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.host) || !url.pathname.startsWith('/attachments/')) {
        throw new Error('InvalidDiscordImageUrl')
      }
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) })
      const mime = response.headers.get('content-type')?.split(';')[0]
      if (!response.ok || !response.body) {
        console.error('Téléchargement image Discord : HTTP ' + response.status)
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
      const content = Buffer.concat(chunks)
      const type = detectImageType(content)
      if (!type || (mime && mime !== 'application/octet-stream' && mime !== type)) {
        throw new Error('InvalidDiscordImage')
      }
      const filename = files.length + '.' + extensions.get(type)
      await writeFile(join(directory, filename), content, { flag: 'wx' })
      files.push({
        media_content_id: 'media-source://media_source/local/' + basename(directory) + '/' + filename,
        media_content_type: type,
      })
    }
    return await callback(files)
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => console.error('Nettoyage des images Discord impossible.'))
  }
}
