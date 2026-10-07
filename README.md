# Magic Clipper for Google Drive ![Version 1.25.0](https://img.shields.io/badge/version-1.25.0-blue.svg) ![Licence MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-brightgreen.svg)


Envoyez n'importe quel fichier que Firefox peut afficher directement sur votre Google Drive en un seul clic.

## ✨ Fonctionnalités

| Fonctionnalité | Détails |
| --- | --- |
| Détection automatique | Analyse de l'URL et du type de contenu de l'onglet actif. |
| Capture de page web | Convertit toute page web en Document PDF structuré (moteur autonome jsPDF avec blindage par liste blanche Unicode anti-débordement et conservation de l'image de couverture) ou Markdown (via Turndown.js) avant envoi vers Drive. |
| 32 Formats supportés | PDF, PNG, JPG, JPEG, GIF, WEBP, SVG, AVIF, BMP, ICO, TIFF, MP3, MP4, WEBM, OGG, WAV, AAC, FLAC, M4A, MOV, MPEG, TXT, MD, CSV, JSON, DOCX, XLSX, PPTX, ZIP, TAR, GZ, EPUB. |
| Upload résumable chunké | Gestion robuste des fichiers volumineux (jusqu'à 200 Mo) via upload par morceaux de 8 Mo avec reprise réseau automatique. |
| Barre de progression | Indication en temps réel de l'état du téléchargement et du téléversement avec pourcentage, débit instantané et estimation du temps restant (ETA). |
| Annulation d'upload | Possibilité d'avorter un transfert en cours à tout moment d'un simple clic. |
| Persistance & Reconnexion | L'état d'upload survit à la suspension du background (Event Page), la popup se reconnecte automatiquement, et un bouton dédié permet la reconnexion à tout moment. |
| Validation Content-Type | Détection et rejet des redirections vers des pages de login déguisées en fichiers. |
| Dossier intelligent | Création automatique d'un dossier `"Imports Magic Clipper"` s'il n'existe pas. |
| Résilience API | Système de retry automatique (1 essai) sur erreurs 401 (token expiré) et 404 (dossier supprimé). |
| Multilingue (i18n) | Traduction native en 6 langues (EN, FR, DE, ES, VI, GCF) avec fallback automatique. |
| Mode sombre natif | Implémenté 100% en CSS via variables, zéro JavaScript. |
| Zéro serveur | Upload direct depuis votre navigateur vers Google Drive, aucun serveur intermédiaire. |

## 🏗 Architecture

```text
mc4gd-firefox/
├── manifest.json             # Manifeste V3 (permissions, Event Page)
├── README.md                 # Documentation du projet
├── lib/                      # Bibliothèques externes pour la capture web
│   ├── Readability.js        # Mozilla Readability (extraction contenu)
│   ├── jspdf.umd.min.js      # jsPDF 2.5.2 (génération PDF)
│   ├── turndown.js           # Turndown 7.2.0 (HTML → Markdown)
│   └── turndown-plugin-gfm.js # Plugin GFM pour Turndown
├── src/
│   ├── background/
│   │   └── background.js     # Authentification OAuth2 et logique d'API Drive
│   ├── content/              # Content scripts de capture web (injectés dynamiquement)
│   │   ├── serializer.js     # Extraction Readability + sérialisation DFS
│   │   ├── pdf_generator.js  # Génération PDF via jsPDF
│   │   ├── md_generator.js   # Génération Markdown via Turndown
│   │   └── orchestrator.js   # Orchestrateur de capture
│   ├── popup/
│   │   ├── popup.html        # Structure UI 100% localisée
│   │   ├── popup.css         # Design Glassmorphism et mode sombre CSS natif
│   │   └── popup.js          # Machine à états UI et communication background
│   └── shared/
│       └── utils.js          # Moteur i18n, détection MIME, constantes globales
├── _locales/
│   ├── en/messages.json      # Locale de référence anglaise
│   └── fr, de, es, vi...     # Traductions
└── icons/
    └── icon.svg              # Icône vectorielle unique (toutes tailles)
```

## 🔄 Pipelines d'import

L'architecture sépare strictement l'UI (popup) et la logique (background) :

1. **Upload direct :**
   La détection s'effectue par analyse de l'URL, avec un fallback HTTP HEAD si l'extension est inconnue. Le fichier est ensuite envoyé à Drive via un upload multipart API v3.
2. **Flux d'authentification :**
   L'extension met en cache le token OAuth2. En cas d'expiration, elle tente d'abord un renouvellement silencieux (`interactive: false`). Ce n'est qu'en dernier recours qu'un flux OAuth interactif est lancé (`interactive: true`).

## 👁 Matrice de visibilité dynamique de la popup

| Élément UI | Condition d'affichage / d'état |
| --- | --- |
| `#upload-btn` | Actif si format supporté, désactivé si chargement/incompatible. |
| `#file-info` | Affiche l'icône et le nom du fichier. |
| `#file-info.warning` | Appliqué si fichier local (`file://`) ou type non supporté. |
| `#drive-link-row` | Visible uniquement après un upload réussi avec lien Drive généré. |
| `#btn-spinner` | Visible pendant l'upload (`uploadCurrentFile`). |
| `#disconnect-btn` | Actif pour révoquer le compte Google, nécessite un double-clic (3s). |
| `#auth-status` | Badge (loading/success/error) selon l'état d'authentification et d'upload. |

## 🛠 Décisions techniques clés

*   **Event Page MV3** : Utilisation d'un background script `type: "module"` classique MV3 (pas de Service Worker, Firefox supportant pleinement les Event Pages).
*   **Synchronisme onMessage** : Tout handler asynchrone `browser.runtime.onMessage` inclut un `return true;` synchrone pour garantir la persistance du canal de communication.
*   **Scope OAuth `drive`** : Le scope global `drive` est utilisé plutôt que `drive.file` pour garantir la visibilité des dossiers `"Imports Magic Clipper"` créés sur d'autres appareils/sessions.
*   **Création de dossier sécurisée** : Toujours `orderBy="createdTime desc"` lors du `files.list` pour identifier le bon dossier, évitant la duplication.
*   **Retry limité** : Un seul retry en cas d'erreur API (401/404) pour éviter toute boucle infinie coûteuse.
*   **Thème CSS pur** : Le mode sombre repose intégralement sur `@media (prefers-color-scheme: dark)`, sans aucune injection JavaScript ni classes `.dark`.

## 💻 Installation et développement

### Installation temporaire
1. Accédez à `about:debugging` dans Firefox.
2. Cliquez sur **"Ce Firefox"**.
3. **"Charger un module temporaire…"** et sélectionnez le `manifest.json`.

### Outils de build
*   **Linting** : Exécutez `web-ext lint` pour valider la conformité aux règles AMO.
*   **Build** : Exécutez `web-ext build` pour générer le fichier `.xpi`.

### Configuration OAuth2
1. Allez sur Google Cloud Console.
2. Créez un ID client OAuth (Type: Application de bureau).
3. Ajoutez le scope non sensible `https://www.googleapis.com/auth/drive.file`.
4. Mettez à jour le `client_id` dans `manifest.json`.

## 🤝 Contribuer

1. Forkez le projet.
2. Créez une branche (`feature/mon-idee` ou `fix/bug-nom`).
3. Rédigez un commit conventionnel (`feat: ...`, `fix: ...`, `refactor: ...`). **Une fonction par commit.**
4. Ouvrez une Pull Request.

---

## 📋 Changelog

Voir [CHANGELOG.md](CHANGELOG.md) pour l'historique complet des versions.

---

## 📄 Licence

Ce projet est sous licence **MPL-2.0** (Mozilla Public License Version 2.0).

---
*Développé par **MTF Karukera**. Découvre toutes les solutions logicielles et outils de productivité de la suite **magic-softs** sur [mtfk.fr](https://mtfk.fr).*
