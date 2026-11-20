import { readFile } from 'node:fs/promises'
import { ChannelType, Client, Events, GatewayIntentBits, Routes } from 'discord.js'
import { createAssist } from './assist.mjs'
import { createVoice } from './voice.mjs'
import { withDiscordImages } from './images.mjs'
import { createTextContext } from './text-context.mjs'

const options = JSON.parse(await readFile('/data/options.json', 'utf8'))
const token = options.discord_token?.trim()
const guildId = options.guild_id?.trim()

if (!token || !/^\d{17,20}$/.test(guildId ?? '')) {
  console.error('Renseigne le jeton du bot et l’identifiant du serveur Discord.')
  process.exit(1)
}

const assist = createAssist(options, process.env.SUPERVISOR_TOKEN)
const voice = createVoice(assist)
const analyzeServerMessages = options.analyze_server_messages === true
const readMessageContent = analyzeServerMessages || options.natural_text_triggers
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates,
    ...(readMessageContent ? [GatewayIntentBits.MessageContent] : []),
  ],
  allowedMentions: { parse: [], repliedUser: false },
})
const pendingMessages = new Set()
const channelQueues = new Map()
const context = createTextContext({
  minutes: options.context_minutes,
  entries: options.context_entries,
  timeZone: options.conversation_timezone,
})
const textChannels = new Set((options.text_channel_ids ?? '').split(/[\s,]+/).filter(Boolean))
const acceptsText = (channelId, parentId) => !textChannels.size || textChannels.has(channelId) || textChannels.has(parentId)

const commands = [
  { name: 'ping', description: 'Vérifie que le bot répond.' },
  { name: 'glados', description: 'Parle à GLaDOS.', options: [
    { type: 3, name: 'message', description: 'Ton message', required: true, max_length: 1600 },
  ] },
  { name: 'voc', description: 'Gère la discussion vocale.', options: [
    { type: 1, name: 'rejoindre', description: 'Invite GLaDOS dans ton salon et active la transcription de ta voix.' },
    { type: 1, name: 'quitter', description: 'Termine ta session vocale.' },
  ] },
]

client.once(Events.ClientReady, async (readyClient) => {
  console.log('Connecté à Discord en tant que ' + readyClient.user.tag + '.')
  for (const command of commands) {
    try {
      await client.rest.post(Routes.applicationGuildCommands(readyClient.user.id, guildId), { body: command })
      console.log('Commande /' + command.name + ' enregistrée.')
    } catch {
      console.error('Échec de l’enregistrement de /' + command.name + '.')
    }
  }
  if (!assist.available) console.log('Conversation inactive : renseigne ai_task_entity et vérifie l’accès à l’API HA.')
  if (!assist.canTranscribe) console.log('VOC inactif : renseigne assist_pipeline.')
})

client.on(Events.VoiceStateUpdate, (before, after) => voice.updateState(before, after, client.user.id))
client.on(Events.MessageCreate, (message) => {
  if (message.guildId !== guildId || message.author.bot || message.webhookId || !assist.available || !acceptsText(message.channelId, message.channel?.parentId)) return
  if (!analyzeServerMessages) {
    void processMessage(message).catch(() => console.error('Traitement du message Discord impossible.'))
    return
  }

  const key = message.channelId
  const pending = channelQueues.get(key) ?? Promise.resolve()
  const next = pending.then(() => processMessage(message))
    .catch(() => console.error('Traitement du message Discord impossible.'))
    .finally(() => {
      if (channelQueues.get(key) === next) channelQueues.delete(key)
    })
  channelQueues.set(key, next)
})

async function processMessage(message) {
  const mention = new RegExp('<@!?' + client.user.id + '>')
  const name = /(?<![\p{L}\p{N}_])glados(?![\p{L}\p{N}_])/iu
  const addressedByName = readMessageContent && name.test(message.content)
  const mentioned = mention.test(message.content)
  const timestamp = message.createdTimestamp
  const userKey = 'user:' + message.channelId + ':' + message.author.id
  const channelKey = 'channel:' + message.channelId
  const exchange = context.history(userKey, timestamp)
  const exchangedIds = new Set(exchange.map((turn) => turn.id))
  const channel = analyzeServerMessages
    ? context.history(channelKey, timestamp).filter((turn) => !exchangedIds.has(turn.id))
    : []
  const history = exchange.map((turn) => context.describe(turn, timestamp, message.author.id))
  const hasImage = message.attachments.some((attachment) => attachment.contentType?.startsWith('image/'))
  let direct = mentioned || (!analyzeServerMessages && addressedByName)
  let referenced
  if (!direct && readMessageContent && message.reference?.messageId) {
    referenced = await message.fetchReference().catch(() => null)
    direct = referenced?.author.id === client.user.id
    if (!direct && !analyzeServerMessages) return
  }
  if (!analyzeServerMessages && !direct && (!options.natural_text_triggers || !history.length || message.mentions.users.size)) return
  if (!analyzeServerMessages && (pendingMessages.has(userKey) || pendingMessages.size >= 4)) return

  const text = message.content.replace(mention, '').trim()
  const input = text.slice(0, 1600)
  if (!analyzeServerMessages && !direct && !input && !message.attachments.size) return

  if (!analyzeServerMessages) pendingMessages.add(userKey)
  const showTyping = () => void message.channel.sendTyping().catch(() => {})
  const showWhileWaiting = direct || addressedByName || !analyzeServerMessages
  if (options.show_typing !== false && showWhileWaiting) showTyping()
  const typing = options.show_typing !== false && showWhileWaiting ? setInterval(showTyping, 8000) : null
  try {
    const imageOnly = options.analyze_images !== false && hasImage && (!input || /^glados[\s,.!?:;…—-]*$/iu.test(input))
    const caption = analyzeServerMessages ? input || (hasImage ? '[image seule]' : '[message sans texte]')
      : imageOnly ? 'Regarde cette image. Décris ce que tu vois.' : input || 'GLaDOS, tu es là ?'
    const prompt = options.analyze_images === false && hasImage
      ? caption + ' [Une image est jointe. Son analyse est désactivée.]'
      : caption
    const speaker = { name: message.author.displayName, id: message.author.id }
    const turn = { id: message.id, role: 'user', text: prompt, speaker, timestamp, hasImage }
    const routing = {
      addressed: direct,
      mentionsGladosByName: addressedByName,
      speaker: speaker.name,
      time: context.describe(turn, timestamp).time,
      timeZone: context.timeZone,
      repliedTo: referenced ? {
        role: referenced.author.id === client.user.id ? 'assistant' : 'user',
        speaker: referenced.author.displayName,
        text: referenced.content.slice(0, 1000),
        time: context.describe({ timestamp: referenced.createdTimestamp }, timestamp).time,
      } : undefined,
      channelHistory: channel.map((entry) => context.describe(entry, timestamp, message.author.id)),
    }
    if (analyzeServerMessages) context.remember(channelKey, timestamp, turn)

    const decision = await withDiscordImages(options.analyze_images === false ? new Map() : message.attachments, async (images) => {
      if (analyzeServerMessages) return assist.respondInContext(prompt, history, images, routing)
      if (direct || (imageOnly && images.length)) return { text: await assist.reply(prompt, history, undefined, images, routing) }
      return assist.respondInContext(prompt, history, images, routing)
    })
    if (!decision) return

    const posted = decision.emoji ? await message.react(decision.emoji) : await message.reply(decision.text)
    const response = {
      id: decision.emoji ? 'reaction:' + message.id : posted.id,
      role: 'assistant', text: decision.text ?? decision.emoji,
      recipient: speaker, timestamp: posted.createdTimestamp ?? Date.now(),
    }
    context.remember(userKey, timestamp, turn, response)
    if (analyzeServerMessages) context.remember(channelKey, timestamp, response)
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]+$/.test(error.code) ? error.code : null
    const imageError = /^(InvalidDiscordImage(?:Url)?|UnsupportedDiscordImage|DiscordImageTooLarge)$/.test(error?.message)
    const detail = code || (imageError ? error.message : error?.name)
    console.error('Échec du traitement Discord (' + (hasImage ? 'image' : 'texte') + ') : ' + (detail || 'inconnu'))
    if (options.analyze_images !== false && hasImage && (direct || addressedByName || !analyzeServerMessages)) {
      await message.reply('Je n’ai pas pu analyser cette image. Le fichier ou le fournisseur IA a refusé le traitement.').catch(() => {})
    } else if (direct) {
      await message.reply('Un petit incident de laboratoire. Réessaie dans un instant.').catch(() => {})
    }
  } finally {
    clearInterval(typing)
    pendingMessages.delete(userKey)
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.guildId !== guildId) return

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply('Pong !')
      return
    }

    if (interaction.commandName === 'glados') {
      if (!acceptsText(interaction.channelId, interaction.channel?.parentId)) {
        await interaction.reply({ content: 'Ce salon est hors du périmètre de discussion.', ephemeral: true })
        return
      }
      if (!assist.available) {
        await interaction.reply({ content: 'Configure une entité AI Task dans Home Assistant.', ephemeral: true })
        return
      }
      await interaction.deferReply()
      const response = await assist.reply(interaction.options.getString('message', true))
      await interaction.editReply(response)
      return
    }

    if (interaction.commandName !== 'voc') return
    if (interaction.options.getSubcommand() === 'quitter') {
      if (voice.owner !== interaction.user.id) {
        await interaction.reply({ content: 'Tu n’as pas de session vocale ouverte.', ephemeral: true })
        return
      }
      voice.leave()
      await interaction.reply('Session terminée. Le laboratoire retrouve son calme.')
      return
    }

    const channel = interaction.guild.voiceStates.cache.get(interaction.user.id)?.channel
    if (!assist.available || !assist.canTranscribe || channel?.type !== ChannelType.GuildVoice || voice.owner) {
      const problem = !assist.available || !assist.canTranscribe ? 'Configure AI Task et le pipeline Assist.'
        : voice.owner ? 'Une session vocale est déjà ouverte.'
          : 'Rejoins d’abord un salon vocal classique.'
      await interaction.reply({ content: problem, ephemeral: true })
      return
    }

    await interaction.reply('Connexion au vocal. Seule ta voix sera transcrite par le fournisseur STT configuré dans Home Assistant.')
    await voice.join(channel, interaction.user.id)
    await interaction.editReply('Je suis dans le vocal. Seule ta voix est transcrite par le fournisseur STT configuré dans Home Assistant. Utilise /voc quitter pour arrêter.')
  } catch {
    console.error('Échec de /' + interaction.commandName + '.')
    const content = 'Le test a échoué. Les journaux de l’app donneront la prochaine piste.'
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {})
    else await interaction.reply({ content, ephemeral: true }).catch(() => {})
  }
})

client.on(Events.ShardReconnecting, () => console.log('Reconnexion à Discord.'))
client.on(Events.ShardResume, () => console.log('Connexion à Discord rétablie.'))
client.on(Events.Error, () => console.error('Erreur de connexion Discord.'))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    voice.leave()
    client.destroy()
  })
}

try {
  await client.login(token)
} catch {
  console.error('Connexion à Discord impossible. Vérifie le jeton et le réseau.')
  client.destroy()
  process.exitCode = 1
}
