# Changelog

Tous les changements notables de Magic Clipper for Google Drive sont documentés ici.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/)
et ce projet respecte le [Semantic Versioning](https://semver.org/lang/fr/).

## [1.10.0] — 2026-06-24

### Sécurité
- Blocage des adresses IPv4-mapped IPv6 (`::ffff:192.168.x.x`) dans la garde anti-SSRF de `isPrivateOrLoopback()`.
- Échappement des apostrophes dans la query de recherche de dossier Google Drive (prévention d'injection dans la chaîne `files.list`).
- Sanitisation étendue des noms de fichiers : suppression des caractères de contrôle (U+0000–U+001F, U+007F), des overrides directionnels Unicode (U+202A–U+202E, U+2066–U+2069), et troncature à 200 caractères avec préservation de l'extension.

### Ajouté
- Focus trap dans le dialog d'onboarding (Tab/Shift+Tab bouclants) avec nettoyage automatique à la fermeture.
- Fermeture du dialog d'onboarding par la touche Escape avec restauration du focus vers l'élément précédent.
- Annonce ARIA accessible lors de la confirmation de déconnexion (`popup_disconnect_confirm_announce`).
- Throttling des annonces de progression ARIA : mise à jour uniquement à chaque changement de phase ou palier de 10%.
- Badge d'authentification auth-aware : vérification de l'`accessToken` en `storage.local` pour distinguer « Connecté » (vert) / « Déconnecté » (orange).
- Nouvelle variable CSS `--status-disconnected` (light + dark) et classe `.status-disconnected` pour le badge « Déconnecté ».
- Notification `uploadComplete` de secours depuis le background : si le port `sendResponse` est fermé après un long flux auth+upload, la popup reçoit le résultat via un message `runtime.sendMessage` séparé.
- Clés i18n `popup_auth_disconnected`, `popup_disconnected_status` et `popup_disconnect_confirm_announce` dans les 6 locales.
- Documentation de la limitation DNS rebinding dans ARCHITECTURE.md §3 (risque accepté).

### Modifié
- Déconnexion fire-and-forget : la révocation du token OAuth2 n'est plus attendue (`await`) par la popup. L'interface se met à jour de manière synchrone.
- Bouton « Déconnecter » masqué automatiquement lorsque l'utilisateur n'est pas authentifié (caché par défaut dans le HTML).
- Touch targets du sélecteur de langue conformes (44px minimum) sous `pointer: coarse`.
- Respect de `prefers-reduced-motion` : désactivation des transitions et animations CSS.

## [1.9.0] — 2026-06-24

### Ajouté
- Upload résumable **chunké par morceaux de 8 Mo** (`CHUNK_SIZE`), remplaçant l'upload monolithique XHR. Empreinte mémoire réduite de ~400 Mo à ~8 Mo pour les gros fichiers.
- Persistance de l'état d'upload (`activeUpload`) dans `browser.storage.local` après chaque chunk. L'état survit à la suspension du background (Event Page MV3).
- Logique de reprise au réveil : vérification de la session résumable via `Content-Range: bytes */{total}` et restauration de l'état en mémoire.
- Retry réseau automatique dans la boucle de chunks : 3 tentatives avec backoff exponentiel (2s→4s→8s) et interrogation de la session avant chaque retry.
- Rafraîchissement préventif du token OAuth2 avant l'upload si le temps estimé de transfert (~3s/Mo) risque de dépasser la durée de vie restante du token.
- Garde anti-double upload : un seul upload par onglet autorisé, les tentatives concurrentes sont rejetées avec un message localisé (`err_upload_in_progress`).
- Validation du Content-Type après téléchargement : rejet des redirections silencieuses vers des pages HTML (portails d'authentification) avec message localisé (`err_content_mismatch`).
- Nouvelles clés i18n `err_upload_in_progress` et `err_content_mismatch` dans les 6 locales.
- Table de mapping `ERROR_I18N_MAP` centralisée pour la conversion erreur→message i18n (remplace la chaîne if-else).
- Fonctions helpers DRY : `scheduleCleanup()`, `notifyPopup()`, `persistUploadState()`, `clearPersistedUploadState()`, `querySessionProgress()`.
- Constantes nommées : `CHUNK_SIZE`, `DOWNLOAD_TIMEOUT_MS`, `UPLOAD_CHUNK_TIMEOUT_MS`, `CLEANUP_DELAY_MS`, `TOKEN_SAFETY_MARGIN_MS`, `SESSION_MAX_AGE_MS`, `NETWORK_RETRY_COUNT`, `NETWORK_RETRY_BASE_DELAY_MS`.

### Modifié
- Remplacement complet de `XMLHttpRequest` par `fetch()` pour l'upload vers Google Drive (protocole résumable chunké avec en-têtes `Content-Range`).
- Le champ `state` des messages de progression est renommé en `phase` (rétrocompatibilité assurée dans la popup via `msg.phase || msg.state`).
- `initI18n()` est désormais attendu (`await i18nReady`) avant tout traitement de message pour garantir que les textes sont traduits dès le premier appel.
- Libération mémoire explicite : `chunks.length = 0` après construction du Blob de téléchargement.

## [1.8.0] — 2026-06-15

### Ajouté
- Timeout de 120 secondes sur le téléchargement du document d'origine (`fetch`) avec gestion de l'annulation (`AbortController`).
- Timeout de 5 minutes sur le téléversement de la session résumable Google Drive v3 via `xhr.timeout = 300000` et rejet en cas de dépassement.
- Garde-fou lors de l'authentification OAuth2 si le paramètre `access_token` retourné est nul ou manquant.
- Écouteur sur `browser.tabs.onRemoved` pour nettoyer et libérer les sessions de téléchargement et d'upload si l'onglet associé est fermé par l'utilisateur.
- Attribut `aria-live="polite"` sur le badge d'authentification pour signaler de manière audible ses changements d'états aux lecteurs d'écran.
- Attribut `data-i18n-aria-label="progress_label"` sur la barre de progression pour lui associer une étiquette textuelle descriptive traduite, et ajout de la clé correspondante dans les 6 dictionnaires de langues.
- Rôle sémantique d'accessibilité `dialog` avec `aria-modal="true"` et `aria-labelledby="onboarding-title"` sur la superposition d'onboarding, et mécanisme de capture automatique du focus sur le bouton de fermeture lors de son affichage.

### Modifié
- Harmonisation du style des focus interactifs en remplaçant `:focus` par `:focus-visible` sur le sélecteur de langue et l'ensemble des boutons de la popup.
- Amélioration de la gestion du focus après un upload réussi en forçant automatiquement le focus sur le lien du fichier Drive.
- Correction du contraste du texte d'avertissement en mode sombre pour respecter le niveau de conformité WCAG AA (passage du orange `#e65100` au orange vif `#d84315`).
- Désactivation automatique de l'animation de rotation continue du spinner de chargement si l'utilisateur a configuré une préférence pour les mouvements réduits (`prefers-reduced-motion: reduce`).
- Nettoyage du code : factorisation de la mise à jour dynamique du statut dans `setStatusLive()` (fusion de `setStatus()`) et suppression de la clé de traduction obsolète `err_file_too_large` dans les 6 dictionnaires de langue.
- Alignement et mise à jour de la documentation technique : correction de l'arborescence et des limites de tailles dans `ARCHITECTURE.md` et `AGENTS.md`, et suppression des anciennes références à NotebookLM résiduelles dans le fichier `index.html`.

## [1.7.0] — 2026-06-15

### Ajouté
- Sessions d'upload résumables de Google Drive v3, rendant les imports volumineux très robustes.
- Augmentation de la limite de taille des fichiers capturés à 200 Mo (contre 5 Mo précédemment) pour supporter l'import de musiques et vidéos.
- Barre de progression animée dans la popup indiquant la progression en pourcentage pour les phases de téléchargement ("downloading") et d'upload ("uploading").
- Bouton d'annulation dynamique pour interrompre activement un transfert de fichier en cours.
- Logique de reconnexion de la popup : fermeture et réouverture sans perturber le transfert en arrière-plan, dont le statut et la progression sont récupérés automatiquement au chargement de la popup.

### Modifié
- Récupération explicite des métadonnées du fichier créé (webViewLink) lors de l'initialisation de l'upload résumable afin de restaurer le bouton "Afficher sur Drive" à la fin du transfert.
- Nouveaux messages de traduction localisés dans les 6 langues supportées pour les états de progression, le bouton d'annulation et les erreurs d'abandon.

## [1.6.0] — 2026-06-15

### Ajouté
- Prise en charge de 16 nouveaux formats de fichiers dans `MIME_MAP` (docx, xlsx, pptx, zip, tar, gz, epub, avif, bmp, ico, tiff, mov, mpeg, aac, flac, m4a), portant à 32 le nombre total de formats gérés.

### Modifié
- Nettoyage des fichiers i18n : suppression des clés de traductions inutilisées (`popup_confirm_disconnect` dans les 6 locales et `popup_error_prefix` dans la locale `gcf`).
- Optimisation et mise en conformité de `icon.svg` (taille réduite à 13 Ko et format carré 1000x1000px) éliminant tous les warnings du linter Firefox tout en conservant le graphisme original.
- Restauration des règles de style du logo (`background-color` et `border-radius` sur `.logo-icon` dans `popup.css`) pour s'adapter à la transparence du logo original.
- Alignement et réécriture de la documentation technique (`README.md`, `ARCHITECTURE.md` et `AGENTS.md`).

## [1.5.0] — 2026-06-15

### Ajouté
- Écran d'onboarding/bienvenue s'affichant lors du premier démarrage avec stockage persistant du statut (`hasSeenWelcome`) dans `browser.storage.local`.
- Ajout de l'image du logo vectoriel (`icon.svg`) dans l'en-tête de la popup.
- Styles `:focus-visible` pour la navigation au clavier (select, bouton envoi, lien, bouton déconnexion, bouton d'accueil).
- Attributs d'accessibilité ARIA : `aria-hidden="true"` sur le spinner, `aria-live="polite"` sur le message de statut.
- Configuration dynamique de la langue du document (`document.documentElement.lang`) lors du changement de locale.

### Modifié
- Remplacement du `<label>` non sémantique de la section de détection par un titre sémantique `<h2>` avec styles CSS correspondants.
- Correction de l'état de confirmation de déconnexion : utilisation de la traduction courte correcte (`popup_btn_disconnect_confirm`) et ajout d'une classe CSS de confirmation visuelle `.confirm-active` (couleur ambre).
- Amélioration des contrastes de couleurs en modes clair et sombre pour répondre aux critères WCAG AA (correction du texte de déconnexion au survol en mode sombre et ajustement du vert de succès).

## [1.4.0] — 2026-06-15

### Ajouté
- En-têtes de licence standard MPL-2.0 ajoutés sur tous les fichiers sources (`background.js`, `popup.js`, `utils.js`, `popup.html`, `popup.css`).

### Modifié
- Nettoyage des permissions dans `manifest.json` : suppression de la permission redondante `activeTab` (déjà couverte par `<all_urls>`).
- Réécriture et correction complète des fichiers de politique de confidentialité (`PRIVACY.md` et `privacy.html`) afin de refléter fidèlement le fonctionnement de l'extension (utilisation du scope `drive` pour la recherche de dossier, absence de serveurs tiers, correction des références à NotebookLM).

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
