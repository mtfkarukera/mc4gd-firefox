# Plan d'Action Complet — Magic Clipper for Google Drive (MC4GD)

Ce document récapitule la feuille de route complète de développement, d'audit de sécurité et de conformité pour l'extension Firefox MV3.

---

## 📊 État d'avancement général

```
🟢🟢🟢🟢🟢🟢🟡🟡⚪⚪  — 6,5 / 10 (Score d'audit initial)
```

Sprints complétés : **3 / 7**  
Version actuelle : **v1.3.0**

---

## 🗺️ Feuille de Route & Sprints

### Sprint 1 — Bootstrap & Moteur i18n
* **Version cible** : v1.1.0  
* **Statut** : ✅ Terminé  
* **Objectif** : Initialisation de l'extension MV3, OAuth2, intégration du design Glassmorphism et du sélecteur de langue (6 locales supportées dont le créole guadeloupéen `gcf`).

### Sprint 2 — 🔒 Durcissement Sécurité
* **Version cible** : v1.2.0  
* **Statut** : ✅ Terminé  
* **Objectif** : Durcissement des communications inter-composants et de la sécurité réseau.
  - [x] Validation du `sender.id` dans `onMessage` (bloque les extensions tierces).
  - [x] Blocage des adresses IP privées, loopback et locales dans `fetch()` (prévention SSRF).
  - [x] Allowlist des locales autorisées (`["en", "fr", "de", "es", "vi", "gcf"]`) dans `initI18n()`.
  - [x] Sanitisation du nom de fichier extrait de l'URL.
  - [x] Révocation sécurisée du token OAuth2 par requête `POST` (plus de token dans l'URL).
  - [x] Validation du préfixe `https://drive.google.com/` pour le lien de retour.
  - [x] Ajout de l'attribut `rel="noopener noreferrer"` sur le lien Drive de la popup.

### Sprint 3 — ⚡ Résilience API & Gestion d'Erreurs
* **Version cible** : v1.3.0  
* **Statut** : ✅ Terminé  
* **Objectif** : Tolérance aux pannes réseau, limitations d'API et blocage des fichiers volumineux.
  - [x] Garde-fou limitant la taille des fichiers capturés à 5 Mo maximum (upload multipart).
  - [x] Pré-vérification de taille proactive via l'analyse de l'en-tête `Content-Length` (requête HEAD).
  - [x] Expiration automatique des requêtes (timeout de 15 secondes) avec `AbortController`.
  - [x] Tentatives automatiques (retries) avec backoff exponentiel (jusqu'à 3 essais) sur les timeouts, les codes d'erreur 429 et 5xx de Google.
  - [x] Verrouillage asynchrone (Mutex) évitant la double création concurrente du dossier parent sur Drive.
  - [x] Traduction de l'erreur réseau (`err_network`) rendue plus robuste.
  - [x] Analyse détaillée des messages d'erreur de Google Drive pour remonter des raisons d'erreur ciblées (quota, limitations, panne).
  - [x] Nouveaux messages d'erreur localisés : `err_file_too_large`, `err_timeout`, `err_rate_limit`, `err_google_server`.

---

### Sprint 4 — 📋 Conformité AMO & Vie Privée
* **Version cible** : v1.4.0  
* **Statut** : 🔲 À planifier  
* **Objectif** : Alignement de l'extension sur les règles strictes de distribution de Mozilla (AMO) et de respect de la vie privée.
  - [ ] Corriger la déclaration `data_collection_permissions` vers `["authentication"]` (manifest.json).
  - [ ] Supprimer la permission non utilisée `activeTab` du manifeste.
  - [ ] Rédiger la justification de l'utilisation de la permission `<all_urls>` dans les notes pour les réviseurs AMO.
  - [ ] Réécrire entièrement le fichier `PRIVACY.md` (mention du stockage local, absence de serveurs tiers, conformité Google API User Data Policy).
  - [ ] Nettoyer les `host_permissions` redondantes (ex: googleapis, accounts.google).
  - [ ] Ajouter les en-têtes de licence MPL-2.0 dans l'ensemble des fichiers source.

### Sprint 5 — 🎨 Accessibilité & UX Polish
* **Version cible** : v1.5.0  
* **Statut** : 🔲 À planifier  
* **Objectif** : Rendre l'extension accessible, conforme aux normes WCAG et offrir une UX fluide.
  - [ ] Ajouter `aria-hidden="true"` sur le spinner et `aria-live="polite"` pour les statuts et alertes.
  - [ ] Mettre en place des styles `:focus-visible` pour la navigation au clavier.
  - [ ] Remplacer la balise `<label>` non sémantique par un titre `<h2>` ou `<span>`.
  - [ ] Configurer la langue de l'interface `document.documentElement.lang` de manière dynamique.
  - [ ] Améliorer le feedback visuel du premier clic de déconnexion (bouton court).
  - [ ] Gérer l'onboarding (premier affichage expliquant la demande d'authentification) avec un flag `hasSeenWelcome`.
  - [ ] Remplacer le div vide de logo par l'icône SVG réelle.
  - [ ] Ajuster les contrastes de couleurs (badge loading, survol bouton déconnexion en mode sombre).

### Sprint 6 — 📝 Documentation & Nettoyage
* **Version cible** : v1.6.0  
* **Statut** : 🔲 À planifier  
* **Objectif** : Résorption de la dette technique de documentation et nettoyage des ressources.
  - [ ] Réécriture complète d'`ARCHITECTURE.md` pour refléter l'état réel du code (v1.3.0+).
  - [ ] Corriger les incohérences de documentation dans `AGENTS.md` (arbre i18n, fonctions, etc.).
  - [ ] Nettoyer les clés i18n inutilisées (`popup_btn_disconnect_confirm` dans les autres locales) et orphelines.
  - [ ] Optimiser la taille de `icon.svg` (1.2 Mo actuellement → cible < 50 Ko).
  - [ ] Ajouter les formats courants manquants dans `MIME_MAP` (docx, xlsx, zip, epub, avif, mov...).

### Sprint 7 — 📦 Upload Resumable (Fichiers > 5 Mo)
* **Version cible** : v1.7.0  
* **Statut** : 🔲 À planifier  
* **Objectif** : Permettre l'upload de fichiers volumineux de manière robuste avec indicateur de progression.
  - [ ] Implémenter le protocole d'upload résumable (resumable session) de Google Drive v3.
  - [ ] Ajouter une barre de progression dynamique dans la popup.
  - [ ] Gérer la reprise après déconnexion ou interruption réseau temporaire.
  - [ ] Lever le garde-fou des 5 Mo en basculant automatiquement sur l'upload résumable.

### — Portage Chromium
* **Version cible** : v2.0.0  
* **Statut** : 🔲 Différé  
* **Objectif** : Portage et publication sur le Chrome Web Store.
