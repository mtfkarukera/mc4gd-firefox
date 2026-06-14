# Changelog

Tous les changements notables de Magic Clipper for Google Drive sont documentés ici.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/)
et ce projet respecte le [Semantic Versioning](https://semver.org/lang/fr/).

## [1.3.0] — 2026-06-14

### Ajouté
- Garde-fou limitant la taille des fichiers capturés à 5 Mo maximum (upload multipart).
- Pré-vérification de taille proactive via l'analyse de l'en-tête `Content-Length` (requête HEAD).
- Expiration automatique des requêtes (timeout de 15 secondes) avec `AbortController`.
- Tentatives automatiques (retries) avec backoff exponentiel (jusqu'à 3 essais) sur les timeouts, les codes d'erreur 429 et 5xx de Google.
- Verrouillage asynchrone (Mutex) évitant la double création concurrente du dossier parent sur Drive.
- Traduction de l'erreur réseau (`err_network`) rendue plus robuste.
- Analyse détaillée des messages d'erreur de Google Drive pour remonter des raisons d'erreur ciblées (quota, limitations, panne).
- Nouveaux messages d'erreur localisés : `err_file_too_large`, `err_timeout`, `err_rate_limit`, `err_google_server`.

## [1.2.0] — 2026-06-14

### Sécurité
- Validation stricte de `sender.id` dans le routeur de messages du background pour rejeter les messages externes.
- Protection contre les attaques SSRF par le blocage des requêtes vers les adresses IP privées, loopback et locales.
- Ajout d'une allowlist stricte pour le chargement des fichiers de locales i18n dans `initI18n`.
- Sanitisation des caractères de contrôle et caractères interdits pour les noms de fichiers issus d'une URL.
- Révocation sécurisée du token OAuth2 par requête POST au lieu de GET (corps encodé en x-www-form-urlencoded).
- Validation de l'adresse racine `https://drive.google.com/` pour le lien de redirection final du fichier uploadé.
- Ajout de l'attribut de sécurité `rel="noopener noreferrer"` sur le lien Drive de la popup.

### Ajouté
- Nouveau message d'erreur localisé `err_private_network` pour notifier l'utilisateur en cas de tentative de capture sur un réseau privé/local.

## [1.1.0] — 2026-05-17

### Ajouté
- Sélecteur de langue Kréyòl (gcf) dans le popup.
- Persistance du choix de langue via `browser.storage.local`.

## [1.0.2] — 2026-05-17

### Corrigé
- Restauration de `<all_urls>` dans `host_permissions`.
- Correction des chemins d'import de `utils.js`.

## [1.0.1] — 2026-05-17

### Corrigé
- Suppression de `"persistent": false` dans `background` (propriété MV2-only).
- Suppression du bloc `"oauth2"` (propriété Chromium-only, warning Firefox).

## [1.0.0] — 2026-05-17

### Ajouté
- Authentification OAuth2 Google Drive (scope `drive`).
- Détection automatique de 16 formats (PDF, images, audio, vidéo, texte).
- Upload multipart vers le dossier Drive `"Imports Magic Clipper"`.
- Retry automatique sur erreurs 401 (token expiré) et 404 (dossier supprimé).
- Internationalisation : 6 locales (EN, FR, DE, ES, VI, GCF).
- Mode sombre natif 100% CSS.
- Interface Glassmorphism avec orbes animées.
