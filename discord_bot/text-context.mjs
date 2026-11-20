export function createTextContext({ minutes = 3, entries = 6, timeZone = 'UTC' } = {}) {
  const sessions = new Map()
  const horizon = minutes * 60_000
  let clock
  try {
    clock = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short', timeZone })
  } catch {
    console.warn('Fuseau horaire de conversation invalide. Utilisation de UTC.')
    clock = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' })
  }

  function history(key, timestamp) {
    const entry = sessions.get(key)
    if (!entry || timestamp - entry.timestamp > horizon) {
      sessions.delete(key)
      return []
    }
    return entry.turns.filter((turn) => timestamp - turn.timestamp <= horizon)
  }

  return {
    history,
    remember(key, timestamp, ...turns) {
      const prior = history(key, timestamp)
      sessions.delete(key)
      sessions.set(key, { timestamp, turns: [...prior, ...turns].slice(-entries) })
      if (sessions.size > 512) sessions.delete(sessions.keys().next().value)
    },
    describe(turn, timestamp, userId) {
      const { timestamp: sentAt, id, speaker, recipient, ...details } = turn
      return {
        ...details,
        speaker: speaker?.name,
        recipient: recipient?.name,
        fromCurrentUser: speaker ? speaker.id === userId : undefined,
        addressedToCurrentUser: recipient ? recipient.id === userId : undefined,
        time: clock.format(sentAt),
        secondsBeforeMessage: Math.max(0, Math.floor((timestamp - sentAt) / 1000)),
      }
    },
    timeZone: clock.resolvedOptions().timeZone,
  }
}
