const base = 'http://supervisor/core'
const websocket = 'ws://supervisor/core/websocket'

export function createAssist({ conversation_agent: agent, assist_pipeline: pipeline }, token) {
  async function request(path, signal, body, responseType = 'json') {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(35000), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) throw new Error('Home Assistant ' + path.split('?')[0].replace(/^\/api\/tts_proxy\/.+$/, '/api/tts_proxy') + ' HTTP ' + response.status)
    return response[responseType]()
  }

  return {
    available: Boolean(token && /^conversation\.[a-z0-9_]+$/.test(agent ?? '') && agent !== 'conversation.home_assistant'),
    canTranscribe: Boolean(pipeline),
    async reply(text, conversationId, signal) {
      const result = await request('/api/conversation/process', signal, {
        text, agent_id: agent, language: 'fr', conversation_id: conversationId ?? undefined,
      })
      const speech = result.response?.speech?.plain?.speech?.trim()
      if (!speech || result.response.response_type === 'error') throw new Error('Assist conversation sans réponse')
      return { speech: speech.slice(0, 1900), conversationId: result.conversation_id }
    },
    async synthesize(message, signal) {
      const result = await request('/api/tts_get_url', signal, {
        engine_id: 'tts.piper', language: 'fr',
        options: { voice: 'fr_FR-glados-medium' }, message, cache: false,
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
