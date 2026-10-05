# CONTRIBUTING.md — Magic Clipper for Google Drive (MC4GD)
## Guide de développement & de livraison
### Mis à jour : Octobre 2026 — v1.24.0

> Ce fichier est **public** et commité sur GitHub.
> Il documente le savoir-faire d'ingénierie et les procédures de livraison du projet.
> Pour les directives de comportement de l'agent IA, voir `AGENTS.md` (privé, non commité).
> Pour l'architecture technique, voir [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Pièges Connus — Régressions à Ne Jamais Reproduire

### 1.1 Scope OAuth2 — `drive` et non `drive.file`

```
✅ https://www.googleapis.com/auth/drive.file
❌ https://www.googleapis.com/auth/drive
```

Le scope `drive.file` est classé non sensible par Google et évite l'audit de sécurité CASA Tier 2/3.
Il donne un accès complet aux fichiers et dossiers créés par l'extension elle-même.
L'identifiant du dossier `"Imports Magic Clipper"` est persisté dans `browser.storage.local`
pour éviter toute recherche superflue, et la recherche `files.list` retrouve bien les dossiers
créés par l'application. Le scope complet `drive` est formellement interdit car restreint.

### 1.2 Recherche de dossier — Ne Jamais Créer de Doublon

Toujours appeler `findFolder()` avant `createFolder()`.
Si plusieurs dossiers portent le même nom (cas possible) : prendre le **plus récent**
(`orderBy=createdTime desc`) et ne jamais en créer un nouveau.

```javascript
// ✅ CORRECT
const folderId = await findFolder(token) ?? await createFolder(token);

// ❌ FAUX — crée un doublon si le dossier existe déjà
const folderId = await createFolder(token);
```

### 1.3 Verrouillage Synchrone Immédiat — Anti-Double-Clic

Le verrou anti-double-upload doit être posé **de manière synchrone**, sur la première
ligne de `handleUploadCurrentFile`, **avant tout `await`**. Sans cela, un double-clic
rapide peut passer la garde et lancer deux uploads simultanés.

```javascript
// ✅ CORRECT — verrou posé avant tout await
async function handleUploadCurrentFile(tab) {
  if (activeUploads[tabId]) return { success: false, error: t("err_upload_in_progress") };
  activeUploads[tabId] = { phase: "initializing", startedAt: Date.now() }; // synchrone
  const detection = await detectFileFromTab(tab); // await seulement après le verrou
  // ...
}
```

De même, `folderCreationPromise` doit être assigné **de manière synchrone** dès l'entrée
de `getOrCreateFolder`, avant tout `await`, pour neutraliser les appels concurrents.

### 1.4 Purge Sécurisée de l'État d'Upload

`clearPersistedUploadState` doit vérifier le jeton d'instance (`startedAt`) avant de vider
`storage.local`. Sans cette vérification, la fin d'un premier upload peut effacer l'état
d'un second upload qui aurait démarré entre-temps.

```javascript
// ✅ CORRECT — vérification de l'identifiant d'instance
async function clearPersistedUploadState(expectedStartedAt) {
  const current = await browser.storage.local.get("activeUpload");
  if (current?.activeUpload?.startedAt !== expectedStartedAt) return; // ne pas effacer
  await browser.storage.local.remove("activeUpload");
}
```

### 1.5 Token OAuth2 — Renouvellement Silencieux Avant Interaction

Toujours tenter un renouvellement silencieux (`interactive: false`) avant de
relancer le flux interactif (`interactive: true`). Ne jamais forcer une popup
OAuth si le token peut être renouvelé en arrière-plan.

```javascript
// ✅ CORRECT — silencieux d'abord, interactif seulement si nécessaire
async function getValidToken() {
  const { accessToken, expiresAt } = await browser.storage.local.get(["accessToken", "expiresAt"]);
  if (accessToken && expiresAt > Date.now() + 120_000) return accessToken;
  const silent = await getAccessToken(false);
  if (silent) return silent;
  return getAccessToken(true); // popup OAuth uniquement en dernier recours
}
```

### 1.6 Upload Résumable — Taille Limite & Libération Mémoire

La taille limite des fichiers est fixée à **200 Mo** (`MAX_FILE_SIZE`). Ne jamais tenter
d'uploader un fichier > 200 Mo sans vérification préalable via `Content-Length`.

Libérer le Blob en mémoire dans le bloc `finally` de la fonction d'upload pour éviter les
pics mémoire : `fileBlob = null;`

### 1.7 Fichiers locaux (`file://`) — Bloqués Définitivement

Les fichiers ouverts depuis le système de fichiers local (`file://`) ne peuvent pas
être récupérés via `fetch()` depuis le background. Cette limitation est définitive.
Afficher le message `err_local_file` à l'utilisateur, ne jamais tenter le `fetch()`.

### 1.8 Détection de Fichier — Double Heuristique

Ne pas se fier uniquement à l'extension dans l'URL.
Combiner l'analyse de l'URL **et** du titre de l'onglet comme second signal.
Ne jamais appeler `fetch()` pour vérifier le MIME type à ce stade — trop coûteux.

### 1.9 Injection Dynamique Séquentielle

#### Ordre d'injection strict
L'injection dynamique via `browser.scripting.executeScript()` doit strictement respecter l'ordre des dépendances :
1. `lib/Readability.js`
2. `lib/jspdf.umd.min.js` (si PDF) OU `lib/turndown.js` puis `lib/turndown-plugin-gfm.js` (si Markdown)
3. `src/content/serializer.js`
4. `src/content/pdf_generator.js` (si PDF) OU `src/content/md_generator.js` (si Markdown)
5. `src/content/orchestrator.js`

#### Sentinelles anti-double-injection
Chaque script injecté vérifie et positionne une sentinelle sur l'objet `window` (`window.__mc4gd_*`). Si la sentinelle est déjà définie, l'exécution s'interrompt immédiatement pour éviter toute redéclaration de variable ou duplication d'écouteurs d'événements.

#### Piège du `return true` asynchrone pour `FETCH_IMAGE`
Dans le gestionnaire `browser.runtime.onMessage.addListener` de `background.js`, le traitement du message `FETCH_IMAGE` est asynchrone pour le téléchargement et la conversion de l'image en Data URL base64. Il est **impératif** d'inclure un `return true;` synchrone dans le listener pour maintenir le canal de communication ouvert. Sans `return true;`, la réponse est perdue et la génération PDF échoue silencieusement lors de la récupération des images.

---

## 2. Règles i18n

- **Zéro texte statique** dans le HTML — tout via `data-i18n` (ou `-title`, `-placeholder`, `-aria-label`)
- La locale `en` est la locale de référence — elle doit **toujours** être 100% complète
- La locale `gcf` (créole guadeloupéen) utilise un mécanisme de sélection manuelle en popup
  (non reconnue nativement par Firefox — persistée sous la clé `locale` dans `storage.local`)
- La constante `FOLDER_NAME = "Imports Magic Clipper"` n'est **jamais** ajoutée aux `messages.json`
- Après chaque ajout de clés i18n : vérifier la complétude des 6 locales (via `tools/check-i18n.js`)
- Les options du sélecteur de langue ("Auto" et "Kréyòl") passent par `data-i18n`, pas en dur dans le HTML

---

## 3. Checklist Publication AMO

À valider avant chaque soumission ou mise à jour sur [addons.mozilla.org](https://addons.mozilla.org) :

- [ ] `browser_specific_settings.gecko.id` défini dans `manifest.json`
- [ ] `gecko.strict_min_version` défini (`"142.0"`)
- [ ] `version` au format `X.Y.Z` strict (pas de suffixe `-beta`, `-rc`)
- [ ] Pas de `browser_style: true` dans `action` (déprécié MV3)
- [ ] Chaque permission listée est réellement utilisée dans le code
- [ ] Zéro `eval()`, `new Function()`, `innerHTML` avec données non sanitisées
- [ ] Zéro bundler — code directement lisible par l'auditeur AMO
- [ ] Zéro secret hardcodé (le Client ID OAuth est une valeur publique dans `background.js`)
- [ ] `web-ext lint` → zéro erreur bloquante (hors base de référence des faux positifs)
- [ ] Justification du scope `drive` rédigée pour les réviseurs AMO

---

## 4. Construction & Test

### 4.1 Construire le XPI

```bash
npx web-ext build --artifacts-dir dist --overwrite-dest
```

Le XPI est généré dans `dist/`. Il embarque uniquement les fichiers runtime :
`manifest.json`, `src/`, `_locales/`, `icons/`, `LICENSE`.

> ⚠️ `dist/` et `web-ext-artifacts/` sont dans `.gitignore` — ne jamais committer les artefacts.

### 4.2 Linter — Base de Référence des Faux Positifs

```bash
web-ext lint --source-dir .
```

**Bruit attendu à IGNORER (au 30/07/2026) :**

- 5 warnings `ICON_NOT_SQUARE` sur `icons/icon.svg` — **faux positif** :
  le SVG est vectoriel et s'adapte à toute taille, le linter ne sait pas évaluer les SVG scalables.

**Toute erreur ou warning au-delà de cette base doit être corrigé avant commit.**

### 4.3 Test Manuel dans Firefox

1. Ouvrir `about:debugging` dans Firefox.
2. Cliquer **« Ce Firefox »** → **« Charger un module temporaire… »** → sélectionner `manifest.json`.
3. Ouvrir un onglet contenant un fichier supporté (PDF, MP3, DOCX, etc.).
4. Cliquer sur l'icône de l'extension → vérifier la détection → cliquer « Envoyer sur Google Drive » → vérifier le lien Drive retourné.

> **Note** : Il n'y a pas de tests automatisés. Le test fonctionnel se fait manuellement dans Firefox ≥ 142.
> L'ajout de tests unitaires sur la logique de détection et d'upload est une dette identifiée.

### 4.4 Plan de Recettage Type (Post-Sprint)

1. **Linter** : `web-ext lint` — 0 erreur hors base de référence.
2. **Test Téléchargement PDF / MP3 / Markdown** : Import sans régression (fichiers variés, y compris > 5 Mo).
3. **Test Concurrence** : Deux clics rapides sur « Envoyer » → un seul upload doit se lancer.
4. **Test Déconnexion** : Déconnecter → vérifier purge stockage et ré-initialisation de l'onglet.
5. **Test Reprise Réseau** : Interrompre le réseau en cours d'upload → vérifier reprise automatique.
