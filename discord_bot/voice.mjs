import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  AudioPlayerStatus, EndBehaviorType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
} from '@discordjs/voice'
import prism from 'prism-media'

export function createVoice(assist) {
  let session

  function leave() {
    if (!session) return
    const active = session
    session = undefined
    active.abort.abort()
    active.player.stop(true)
    if (active.connection.state.status !== VoiceConnectionStatus.Destroyed) active.connection.destroy()
    console.log('Session vocale terminée.')
  }

  async function handleSpeech(active, userId) {
    if (session !== active || !active.ready || active.busy || userId !== active.owner) return

    active.busy = true
    const { signal } = active.abort
    let stage = 'capture'
    try {
      const audio = active.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      })
      const unpack = new Transform({
        writableObjectMode: true,
        transform(packet, encoding, callback) {
          callback(null, Buffer.isBuffer(packet) ? packet : packet.payload)
        },
      })
      const decoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 })
      const chunks = []
      const captureTimeout = setTimeout(() => audio.push(null), 12000)
      try {
        await pipeline(audio, unpack, decoder, async function consume(source) {
          for await (const chunk of source) chunks.push(chunk)
        }, { signal })
      } finally {
        clearTimeout(captureTimeout)
        audio.destroy()
      }

      const pcm = Buffer.concat(chunks)
      if (pcm.length < 6400) return
      stage = 'STT'
      const text = await assist.transcribe(pcm, signal)
      if (!text) return
      stage = 'conversation'
      const reply = await assist.reply(text, active.conversationId, signal)
      active.conversationId = reply.conversationId
      stage = 'TTS Piper'
      const sound = await assist.synthesize(reply.speech, signal)

      signal.throwIfAborted()
      stage = 'lecture Discord'
      const playback = AbortSignal.any([signal, AbortSignal.timeout(45000)])
      const input = Readable.from([sound])
      try {
        active.player.play(createAudioResource(input))
        await entersState(active.player, AudioPlayerStatus.Playing, AbortSignal.any([playback, AbortSignal.timeout(10000)]))
        await entersState(active.player, AudioPlayerStatus.Idle, playback)
        console.log('Réponse vocale diffusée.')
        await delay(500, undefined, { signal })
      } finally {
        active.player.stop(true)
        input.destroy()
      }
    } catch {
      if (!signal.aborted) console.error('Échec vocal à l’étape ' + stage + '.')
    } finally {
      active.busy = false
    }
  }

  return {
    get owner() { return session?.owner },
    leave,
    updateState(oldState, newState, botId) {
      if (!session || newState.guild.id !== session.channel.guild.id) return
      if ((newState.id === session.owner || newState.id === botId) &&
          oldState.channelId === session.channel.id && newState.channelId !== session.channel.id) leave()
    },
    async join(channel, owner) {
      if (session) throw new Error('Session vocale déjà ouverte')
      const player = createAudioPlayer()
      const connection = joinVoiceChannel({
        channelId: channel.id, guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false,
      })
      const active = { channel, owner, player, connection, abort: new AbortController(), ready: false, busy: false }
      session = active
      player.on('error', () => console.error('Erreur du lecteur vocal Discord.'))
      connection.on('error', () => {
        console.error('Erreur de connexion vocale Discord.')
        if (session === active) leave()
      })
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        if (session === active) leave()
      })
      connection.subscribe(player)
      connection.receiver.speaking.on('start', (id) => void handleSpeech(active, id))
      try {
        await entersState(connection, VoiceConnectionStatus.Ready,
          AbortSignal.any([active.abort.signal, AbortSignal.timeout(20000)]))
        active.ready = true
        console.log('Session vocale prête.')
      } catch (error) {
        if (session === active) leave()
        throw error
      }
    },
  }
}
