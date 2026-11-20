# Bot GLaDOS pour Home Assistant OS

Bot Discord auto-hébergé pour Home Assistant OS (amd64 et aarch64). Il répond à `/ping`, `/glados` et aux mentions directes. En vocal, `/voc rejoindre` écoute la personne qui lance la session, puis lit les réponses via Piper. `/voc quitter` ferme la session.

## Installation

1. Dans **Paramètres → Applications → Installer une application → Dépôts**, ajoute `https://github.com/kechnomicrosft-lab/Bot-GlaDos`.
2. Installe **Discord Bot Host**. Configure `discord_token` avec le jeton du bot et `guild_id` avec l’identifiant du serveur Discord. Invite le bot sur ce serveur.
3. Pour la conversation, configure `conversation_agent` avec l’identifiant d’un agent dédié dans Home Assistant. Désactive le contrôle des appareils sur cet agent. Exemple de consigne : « Réponds naturellement en français, avec un humour sec et un sarcasme mesuré. Fais court à l’oral. »
4. Pour le vocal, renseigne `assist_pipeline` avec l’identifiant d’un pipeline doté d’un moteur STT. Le TTS utilise `tts.piper` et requiert la voix `fr_FR-glados-medium` dans Piper. Le bot requiert les permissions Discord **Se connecter** et **Parler** dans le salon vocal.
5. Démarre l’app, consulte son journal et teste `/ping`, puis `/glados` et `/voc rejoindre`. Si tu migres depuis une installation locale, arrête celle-ci avant de démarrer l’app du dépôt avec le même jeton.

Les réglages et le jeton Discord sont saisis dans Home Assistant. Le bot utilise le jeton interne du Supervisor pour joindre Assist et Piper. La transcription passe par le fournisseur STT du pipeline choisi.

## Versions

Une modification de `discord_bot/` sur `main` lance les contrôles JavaScript et la construction de l’image multiarchitecture sur GitHub Actions. Augmente `version` dans `discord_bot/config.yaml` pour chaque mise à jour distribuée. Le Supervisor utilise le Dockerfile du dépôt pour construire le conteneur. Le package GHCR est publié en parallèle.
## Parler sans commande

Active **Message Content Intent** dans le portail développeur Discord, section **Bot**, puis active `natural_text_triggers` dans les réglages de Discord Bot Host et redémarre le bot. Écris « GLaDOS, tu en penses quoi ? » ou réponds directement à un message du bot. Les conversations entre humains restent silencieuses. Les mentions directes et les commandes restent disponibles. Tous les membres ayant accès au salon peuvent solliciter le bot.
