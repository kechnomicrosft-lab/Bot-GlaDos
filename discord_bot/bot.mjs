import { readFile } from 'node:fs/promises'
import { ChannelType, Client, Events, GatewayIntentBits, Routes } from 'discord.js'
import { createAssist } from './assist.mjs'
import { createVoice } from './voice.mjs'

const options = JSON.parse(await readFile('/data/options.json', 'utf8'))
const token = options.discord_token?.trim()
const guildId = options.guild_id?.trim()

if (!token || !/^\d{17,20}$/.test(guildId ?? '')) {
  console.error('Renseigne le jeton du bot et l’identifiant du serveur Discord.')
  process.exit(1)
}

const assist = createAssist(options, process.env.SUPERVISOR_TOKEN)
const voice = createVoice(assist)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates,
    ...(options.natural_text_triggers ? [GatewayIntentBits.MessageContent] : []),
  ],
  allowedMentions: { parse: [], repliedUser: false },
})
const pendingMessages = new Set()
const textSessions = new Map()
const sessionDuration = 3 * 60 * 1000

function rememberTextSession(key, history) {
  textSessions.delete(key)
  textSessions.set(key, { history: history.slice(-6), expires: Date.now() + sessionDuration })
  if (textSessions.size > 256) textSessions.delete(textSessions.keys().next().value)
}
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
client.on(Events.MessageCreate, async (message) => {
  if (message.guildId !== guildId || message.author.bot || message.webhookId || !assist.available) return
  const mention = new RegExp('<@!?' + client.user.id + '>')
  const name = /^(?:(?:salut|bonjour|bonsoir|hey|coucou)[\s,]+)?glados(?=$|[\s,.!?:;…—-])/iu
  const addressedByName = options.natural_text_triggers && name.test(message.content)
  const mentioned = mention.test(message.content)
  const key = message.channelId + ':' + message.author.id
  const previous = textSessions.get(key)
  const history = previous?.expires > Date.now() ? previous.history : []
  if (previous && !history.length) textSessions.delete(key)

  let direct = addressedByName || mentioned
  if (!direct && options.natural_text_triggers && message.reference?.messageId) {
    const referenced = await message.fetchReference().catch(() => null)
    if (referenced?.author.id !== client.user.id) return
    direct = true
  }
  if (!direct && (!options.natural_text_triggers || !history.length || message.mentions.users.size)) return
  if (pendingMessages.has(key) || pendingMessages.size >= 4) return

  const text = message.content.replace(mention, '').trim()
  const input = (addressedByName ? text.replace(name, '').replace(/^[\s,.!?:;…—-]+/u, '') : text).trim().slice(0, 1600)
  if (!direct && !input) return

  pendingMessages.add(key)
  try {
    const prompt = input || 'GLaDOS, tu es là ?'
    const decision = direct ? { text: await assist.reply(prompt, history) } : await assist.respondInContext(prompt, history)
    if (!decision) return
    if (decision.emoji) await message.react(decision.emoji)
    else await message.reply(decision.text)
    rememberTextSession(key, [
      ...history,
      { role: 'user', text: prompt },
      { role: 'assistant', text: decision.text ?? decision.emoji },
    ])
  } catch {
    console.error('Échec du traitement de la conversation Discord.')
    if (direct) await message.reply('Un petit incident de laboratoire. Réessaie dans un instant.').catch(() => {})
  } finally {
    pendingMessages.delete(key)
  }
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.guildId !== guildId) return

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply('Pong !')
      return
    }

    if (interaction.commandName === 'glados') {
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
