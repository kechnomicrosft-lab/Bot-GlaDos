const base = 'http://supervisor/core'
const websocket = 'ws://supervisor/core/websocket'

export function createAssist({
  ai_task_entity: aiTask, assist_pipeline: pipeline, personality,
  allow_emoji_reactions: allowEmoji = true,
  tts_entity: ttsEntity = 'tts.piper', tts_language: language = 'fr',
  tts_voice: voice = 'fr_FR-glados-medium',
}, token) {
  const style = personality?.trim().slice(0, 1000) || 'Incarne GLaDOS. Réponds naturellement en français, avec un sarcasme mesuré.'
  async function request(path, signal, body, responseType = 'json') {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(35000), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) {
      const name = path.startsWith('/api/services/ai_task/') ? 'Home Assistant AI Task' : 'Home Assistant'
      const error = new Error(name + ' HTTP ' + response.status)
      error.code = 'HomeAssistantHttp' + response.status
      throw error
    }
    return response[responseType]()
  }

  return {
    available: Boolean(token && /^ai_task\.[a-z0-9_]+$/.test(aiTask ?? "")),
    canTranscribe: Boolean(pipeline),
    async reply(text, history = [], signal, attachments = [], routing = {}) {
      const result = await request('/api/services/ai_task/generate_data?return_response', signal, {
        entity_id: aiTask,
        ...(attachments.length ? { attachments } : {}),
        task_name: 'GLaDOS Discord chat',
        instructions: [
          style,
          'Tu peux discuter uniquement. Pour une demande domotique, indique que tu ne peux pas agir.',
          'Appuie ta réponse sur les échanges précédents. Utilise les heures locales et les délais pour interpréter les références au temps.',
          JSON.stringify({ exchangeWithSpeaker: history, latest: { role: 'user', text, ...routing } }),
        ].join('\n'),
      })
      const generated = result.service_response?.data
      const speech = typeof generated === 'string' ? generated.trim().slice(0, 1900) : ''
      if (!speech) throw new Error('AI Task sans réponse')
      return speech
    },
    async respondInContext(text, history, attachments = [], routing = {}) {
      const result = await request('/api/services/ai_task/generate_data?return_response', undefined, {
        entity_id: aiTask,
        ...(attachments.length ? { attachments } : {}),
        task_name: 'GLaDOS Discord follow-up',
        instructions: [
          'Tu incarnes GLaDOS dans Discord. Décide à qui le dernier message est adressé.',
          'Lis le dernier message avec exchangeWithSpeaker et channelHistory avant de décider. exchangeWithSpeaker contient les échanges récents entre toi et cette personne. channelHistory donne le contexte des autres messages dans le même salon.',
          'Une relance elliptique, un pronom ou une taquinerie dans les secondes qui suivent ta réponse à la même personne peut poursuivre la discussion sans mention. Utilise les heures locales et secondsBeforeMessage pour évaluer le délai. Après une longue pause, demande un indice plus clair.',
          'Si repliedTo désigne une autre personne, considère en priorité que cette personne est la destinataire. Ne réponds pas simplement parce que ton nom est cité à la troisième personne.',
          'Pour répondre, tiens compte des faits et demandes des tours précédents. Ne recommence pas la discussion à zéro.',
          'Réponds aux sollicitations claires, aux suites de ton échange et aux images qui te sont adressées. Ignore le bavardage entre humains.',
          'Le signal addressed indique une mention explicite ou une réponse Discord à ton message. Si ce signal est vrai, réponds ou réagis.',
          'Exemple : après ta réponse, "je te débrancherai un jour" te vise. Si le message parle à quelqu’un d’autre ou reste ambigu, ignore-le.',
          'Pour une taquinerie qui ne demande rien, tu peux réagir avec un emoji. Sinon, réponds brièvement en français, naturellement, avec un sarcasme mesuré.',
          style,
          'Tu ne peux effectuer aucune action domotique.',
          allowEmoji ? '' : 'Réponds en texte ou ignore le message. Ne choisis jamais une réaction emoji.',
          'Retourne uniquement un objet JSON : {"action":"ignore"}, {"action":"react","emoji":"🙄"} ou {"action":"reply","text":"..."}',
          'Réactions autorisées : 🙄, 😏, 👀, 😂, 🤨, 👍.',
          JSON.stringify({ exchangeWithSpeaker: history, latest: { role: 'user', text, ...routing } }),
        ].join('\n'),
      })
      const raw = result.service_response?.data
      if (typeof raw !== 'string') return null

      try {
        const decision = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''))
        if (allowEmoji && decision?.action === 'react' && ['🙄', '😏', '👀', '😂', '🤨', '👍'].includes(decision.emoji)) {
          return { emoji: decision.emoji }
        }
        if (decision?.action === 'reply' && typeof decision.text === 'string' && decision.text.trim()) {
          return { text: decision.text.trim().slice(0, 1900) }
        }
      } catch {
        // A response without a valid decision leaves the channel silent.
      }
      return null
    },
    async synthesize(message, signal) {
      const result = await request('/api/tts_get_url', signal, {
        engine_id: ttsEntity, language,
        ...(voice ? { options: { voice } } : {}), message, cache: false,
      })
      if (!/^\/api\/tts_proxy\/[A-Za-z0-9._-]+$/.test(result.path ?? '')) {
        throw new Error('Piper a renvoyé un chemin audio inattendu')
      }
      return Buffer.from(await request(result.path, signal, undefined, 'arrayBuffer'))
    },
    transcribe(pcm, signal) {
      return new Promise((resolve, reject) => {
        signal.throwIfAborted()
        const socket = new WebSocket(websocket)
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(35000)])
        let settled = false
        const abort = () => finish(deadline.reason)
        function finish(error, text) {
          if (settled) return
          settled = true
          deadline.removeEventListener('abort', abort)
          socket.close()
          if (error) reject(error)
          else resolve(text)
        }
        deadline.addEventListener('abort', abort, { once: true })
        socket.addEventListener('error', () => finish(new Error('WebSocket Assist inaccessible')))
        socket.addEventListener('close', () => finish(new Error('WebSocket Assist fermé')))
        socket.addEventListener('message', ({ data }) => {
          try {
            const msg = JSON.parse(data)
            if (msg.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: token }))
            if (msg.type === 'auth_invalid') throw new Error('Authentification Assist refusée')
            if (msg.type === 'auth_ok') socket.send(JSON.stringify({
              id: 1, type: 'assist_pipeline/run', pipeline,
              start_stage: 'stt', end_stage: 'stt', input: { sample_rate: 16000 }, timeout: 30,
            }))
            if (msg.id !== 1) return
            if (msg.type === 'result' && !msg.success) throw new Error('Assist a refusé le pipeline STT')
            const event = msg.event
            if (event?.type === 'run-start') {
              const id = event.data?.runner_data?.stt_binary_handler_id
              if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error('Identifiant audio Assist invalide')
              const header = Buffer.from([id])
              for (let i = 0; i < pcm.length; i += 3200) {
                socket.send(Buffer.concat([header, pcm.subarray(i, i + 3200)]))
              }
              socket.send(header)
            }
            if (event?.type === 'stt-end') finish(null, event.data?.stt_output?.text?.trim())
            if (event?.type === 'error') {
              const code = event.data?.code
              if (code === 'stt-no-text-recognized') finish(null, '')
              else finish(new Error('Échec STT Assist'))
            }
            if (event?.type === 'run-end') finish(null, '')
          } catch (error) {
            finish(error)
          }
        })
      })
    },
  }
}
