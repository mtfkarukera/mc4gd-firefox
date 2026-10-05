# API-REFERENCE.md — Magic Clipper for Google Drive (MC4GD)
## Référence des APIs Google utilisées
### Version : 1.13.0 — Juillet 2026

> Documentation technique de référence des APIs pour le projet MC4GD.

---

## 1. Vue d\'Ensemble

MC4GD utilise deux APIs Google :

| API | Usage | Base URL |
|-----|-------|----------|
| Google OAuth 2.0 | Authentification utilisateur | `https://accounts.google.com/o/oauth2/` |
| Google Drive API v3 | Gestion dossier + upload PDF | `https://www.googleapis.com/drive/v3/` |

Toutes les requêtes Drive portent le header :
```
Authorization: Bearer {accessToken}
```

Le `accessToken` est un token OAuth2 à courte durée de vie (3600s par défaut).
Il est obtenu et renouvelé exclusivement par `background.js`.

---

## 2. Authentification OAuth2

### 2.1 Flux `launchWebAuthFlow`

MC4GD utilise le flux **implicit grant** (token directement dans le hash de réponse).
Aucun `client_secret` n\'est nécessaire — le Client ID suffit pour les extensions browser.

```javascript
const CLIENT_ID   = "VOTRE_CLIENT_ID.apps.googleusercontent.com";
const SCOPES      = "https://www.googleapis.com/auth/drive.file";
const redirectURL = browser.identity.getRedirectURL();

const authURL = "https://accounts.google.com/o/oauth2/auth"
  + `?client_id=${encodeURIComponent(CLIENT_ID)}`
  + `&redirect_uri=${encodeURIComponent(redirectURL)}`
  + `&response_type=token`
  + `&scope=${encodeURIComponent(SCOPES)}`;

const responseURL = await browser.identity.launchWebAuthFlow({
  url: authURL,
  interactive: interactive   // true = popup consent, false = silencieux
});
```

> ⚠️ Le `CLIENT_ID` est déclaré dans le `manifest.json` (clé `oauth2`),
> jamais hardcodé en clair dans le JS.

### 2.2 Extraction du Token depuis la Réponse

La réponse OAuth2 est une URL dont le hash contient les paramètres du token :

```
https://REDIRECT_URL#access_token=TOKEN&expires_in=3599&token_type=Bearer&scope=...
```

```javascript
const params      = new URLSearchParams(new URL(responseURL).hash.slice(1));
const token       = params.get("access_token");
const expiresIn   = parseInt(params.get("expires_in")) || 3600;
const expiresAt   = Date.now() + expiresIn * 1000;

await browser.storage.local.set({ accessToken: token, expiresAt });
```

### 2.3 Vérification et Renouvellement du Token

```javascript
async function getValidToken() {
  const { accessToken, expiresAt } = await browser.storage.local.get(
    ["accessToken", "expiresAt"]
  );

  // Token valide avec 2 min de marge
  if (accessToken && expiresAt > Date.now() + 120_000) {
    return accessToken;
  }

  // Tentative silencieuse d\'abord (pas de popup)
  const silentToken = await getAccessToken(false);
  if (silentToken) return silentToken;

  // Flux interactif uniquement en dernier recours
  return getAccessToken(true);
}
```

> Règle absolue : ne jamais forcer `interactive: true` sans avoir tenté
> `interactive: false`. Une popup OAuth inattendue dégrade fortement l\'UX.

### 2.4 Révocation du Token

```http
POST https://accounts.google.com/o/oauth2/revoke?token={accessToken}
```

```javascript
async function disconnect() {
  const { accessToken } = await browser.storage.local.get("accessToken");
  if (accessToken) {
    // Révocation côté Google (best-effort — ne pas bloquer sur l\'erreur)
    await fetch(
      `https://accounts.google.com/o/oauth2/revoke?token=${accessToken}`
    ).catch(() => {});
  }
  await browser.storage.local.remove(["accessToken", "expiresAt", "folderId"]);
}
```

### 2.5 Scopes OAuth2

| Scope | Accès | Utilisation MC4GD |
|-------|-------|-------------------|
| `https://www.googleapis.com/auth/drive.file` | Fichiers et dossiers créés par l'extension | **Scope utilisé (Non sensible)** |
| `https://www.googleapis.com/auth/drive` | Accès complet Drive | ❌ Interdit (Scope restreint / audit CASA) |

> **Pourquoi `drive.file` et non `drive` ?**
> Le scope `drive.file` est classé comme non sensible par Google et dispense de l'audit de sécurité tiers CASA Tier 2/3.
> Il octroie l'accès complet aux fichiers et dossiers créés par l'extension. L'identifiant du dossier `"Imports Magic Clipper"` est persisté dans `browser.storage.local` et la recherche retrouve les dossiers créés par l'application.

---

## 3. Recherche du Dossier Cible

### 3.1 Endpoint

```
GET https://www.googleapis.com/drive/v3/files
```

### 3.2 Paramètres de requête

| Paramètre | Valeur | Description |
|-----------|--------|-------------|
| `q` | voir §3.3 | Filtre de recherche |
| `orderBy` | `createdTime desc` | Plus récent en premier |
| `fields` | `files(id,name)` | Réduire la réponse au minimum |

### 3.3 Construction de la Requête `q`

```javascript
const FOLDER_NAME = "Imports Magic Clipper"; // constante — ne jamais localiser

const q = `name='${FOLDER_NAME}' `
        + `and mimeType='application/vnd.google-apps.folder' `
        + `and trashed=false`;

const url = "https://www.googleapis.com/drive/v3/files"
          + `?q=${encodeURIComponent(q)}`
          + `&orderBy=createdTime+desc`
          + `&fields=files(id,name)`;

const res  = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` }
});
const data = await res.json();
```

### 3.4 Structure de Réponse

```json
{
  "files": [
    { "id": "1aBcDeFgHiJkLmNoPqRsTuVwXyZ", "name": "Imports Magic Clipper" }
  ]
}
```

- Si `files` est vide (`[]`) → le dossier n\'existe pas → appeler `createFolder()`
- Si `files` contient plusieurs entrées → prendre `files[0]` (le plus récent, `orderBy desc`)
- Ne jamais créer de nouveau dossier si `files[0]` existe

```javascript
async function findFolder(token) {
  // ... requête ci-dessus ...
  return data.files?.[0]?.id ?? null;
}
```

---

## 4. Création du Dossier

### 4.1 Endpoint

```
POST https://www.googleapis.com/drive/v3/files
Content-Type: application/json
Authorization: Bearer {accessToken}
```

### 4.2 Corps de la Requête

```json
{
  "name": "Imports Magic Clipper",
  "mimeType": "application/vnd.google-apps.folder"
}
```

### 4.3 Structure de Réponse

```json
{
  "id": "1aBcDeFgHiJkLmNoPqRsTuVwXyZ",
  "name": "Imports Magic Clipper",
  "mimeType": "application/vnd.google-apps.folder"
}
```

```javascript
async function createFolder(token) {
  const res = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder"
    })
  });
  const data = await res.json();
  if (!data.id) throw new Error("Création du dossier Drive échouée.");
  await browser.storage.local.set({ folderId: data.id });
  return data.id;
}
```

### 4.4 Orchestrateur findOrCreate

```javascript
async function getOrCreateFolder(token) {
  // Vérifier le cache d\'abord
  const { folderId } = await browser.storage.local.get("folderId");
  if (folderId) return folderId;

  // Rechercher en ligne
  const found = await findFolder(token);
  if (found) {
    await browser.storage.local.set({ folderId: found });
    return found;
  }

  // Créer uniquement si introuvable
  return createFolder(token);
}
```

> ⚠️ En cas d\'erreur 404 pendant l\'upload (dossier supprimé entre-temps) :
> `await browser.storage.local.remove("folderId")` puis rappeler `getOrCreateFolder()`.

---

## 5. Upload PDF — Multipart (≤ 5 Mo)

### 5.1 Endpoint

```
POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink
Content-Type: multipart/related; boundary=...
Authorization: Bearer {accessToken}
```

### 5.2 Construction de la Requête

```javascript
async function uploadPdf(url, fileName, token, folderId) {

  // Téléchargement du PDF depuis l\'URL de l\'onglet actif
  const fileResponse = await fetch(url);
  if (!fileResponse.ok) {
    throw new Error(`Impossible de télécharger le fichier. HTTP ${fileResponse.status}`);
  }
  const fileBlob = await fileResponse.blob();

  // Metadata Drive
  const metadata = {
    name:     fileName,
    mimeType: "application/pdf",
    parents:  [folderId]
  };

  // Corps multipart
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], {
    type: "application/json"
  }));
  form.append("file", fileBlob);

  // Upload
  const uploadRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files"
    + "?uploadType=multipart&fields=id,name,webViewLink",
    {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}` },
      body:    form
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.json();
    throw new Error(err.error?.message || `Erreur upload HTTP ${uploadRes.status}`);
  }

  return uploadRes.json(); // { id, name, webViewLink }
}
```

### 5.3 Structure de Réponse

```json
{
  "id": "1aBcDeFgHiJkLmNoPqRsTuVwXyZ",
  "name": "rapport-annuel-2025.pdf",
  "webViewLink": "https://drive.google.com/file/d/1aBcDeFg.../view?usp=drivesdk"
}
```

Le `webViewLink` est le lien affiché à l\'utilisateur dans la popup après succès.

---

## 6. Upload PDF — Resumable (> 5 Mo) *(v1.1.0)*

À implémenter en sprint 2. Documenter ici à titre de référence préalable.

### 6.1 Étape 1 — Initiation de la session

```http
POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable
Content-Type: application/json
Authorization: Bearer {accessToken}
X-Upload-Content-Type: application/pdf
X-Upload-Content-Length: {fileSize}

{ "name": "fichier.pdf", "parents": ["{folderId}"] }
```

Réponse : header `Location` contient l\'URL de session resumable.

### 6.2 Étape 2 — Upload du contenu

```http
PUT {sessionURL}
Content-Range: bytes 0-{fileSize-1}/{fileSize}
Content-Type: application/pdf

[corps binaire du fichier]
```

### 6.3 Étape 3 — Vérification

Réponse HTTP 200/201 → upload complet, corps = metadata du fichier créé.
Réponse HTTP 308 → upload partiel, reprendre depuis le byte indiqué dans `Range`.

> Pour MC4GD v1.0.0, l\'upload multipart (§5) est suffisant.
> Implémenter le resumable en v1.1.0 uniquement.

---

## 7. Gestion des Erreurs Drive

### 7.1 Codes HTTP et Comportements Attendus

| Code | Signification | Action |
|------|--------------|--------|
| 200 / 201 | Succès | Afficher lien `webViewLink` |
| 400 | Requête malformée | Logger le corps de l\'erreur, message utilisateur générique |
| 401 | Token expiré | Purger `accessToken` + `expiresAt`, relancer `getValidToken()`, 1 retry |
| 403 | Scope insuffisant ou quota dépassé | Message utilisateur explicite — ne pas retry |
| 404 | Dossier supprimé | Purger `folderId`, appeler `getOrCreateFolder()`, 1 retry |
| 429 | Rate limit | Attendre 2 secondes, retry (max 3 tentatives avec backoff) |
| 5xx | Erreur serveur Google | Message utilisateur, suggérer de réessayer |

### 7.2 Pattern de Retry 401 (Token Expiré)

```javascript
async function uploadWithRetry(url, fileName) {
  let token = await getValidToken();
  let folderId = await getOrCreateFolder(token);

  try {
    return await uploadPdf(url, fileName, token, folderId);

  } catch (err) {
    // Retry unique sur expiration token
    if (err.message?.includes("401")) {
      await browser.storage.local.remove(["accessToken", "expiresAt"]);
      token = await getValidToken();
      return uploadPdf(url, fileName, token, folderId);
    }
    // Retry unique sur dossier supprimé
    if (err.message?.includes("404")) {
      await browser.storage.local.remove("folderId");
      folderId = await getOrCreateFolder(token);
      return uploadPdf(url, fileName, token, folderId);
    }
    throw err; // Toute autre erreur remonte à l\'appelant
  }
}
```

### 7.3 Messages Utilisateur — Règle Absolue

- Ne jamais afficher un code HTTP brut à l\'utilisateur
- Ne jamais laisser un spinner infini — toute erreur produit un message explicite
- Utiliser les clés i18n pour tous les messages d\'erreur affichés en popup

```javascript
// ✅ CORRECT
sendResponse({ success: false, error: browser.i18n.getMessage("errUploadFailed") });

// ❌ FAUX
sendResponse({ success: false, error: "HTTP 403" });
```

---

## 8. Détection PDF — Heuristique Double

MC4GD doit détecter si l\'onglet actif est un PDF uploadable **sans faire de requête réseau**.

```javascript
function isPdfTab(url, title) {
  if (!url) return false;
  // Blocage fichiers locaux — définitif
  if (url.startsWith("file://")) return { eligible: false, reason: "local" };
  // Blocage pages système
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { eligible: false, reason: "system" };
  }
  // Heuristique 1 : extension dans l\'URL
  const urlLower = url.toLowerCase();
  if (urlLower.includes(".pdf")) return { eligible: true };
  // Heuristique 2 : titre de l\'onglet
  if (title?.toLowerCase().endsWith(".pdf")) return { eligible: true };
  return { eligible: false, reason: "notPdf" };
}
```

> Ne jamais appeler `fetch()` (HEAD ou GET) depuis la popup pour vérifier le MIME type.
> La détection d\'éligibilité doit être instantanée, sans latence réseau.
> Si l\'URL ne contient pas `.pdf` mais que c\'est effectivement un PDF (ex: PDF servi
> par un CDN avec une URL sans extension), l\'upload échouera proprement avec un message
> explicite — c\'est acceptable pour v1.0.0.

---

## 9. Construction du Nom de Fichier

```javascript
function buildFileName(url, title) {
  // Priorité 1 : nom depuis l\'URL
  const raw = decodeURIComponent(url.split("/").pop().split("?")[0]);
  if (raw.toLowerCase().endsWith(".pdf")) return raw;
  // Priorité 2 : titre de l\'onglet + extension
  const clean = (title || "document")
    .replace(/[\\\\/:*?"<>|]/g, "_")   // caractères interdits Windows/Drive
    .trim()
    .substring(0, 100);
  return clean + ".pdf";
}
```

> Limiter à 100 caractères pour la lisibilité dans Drive.
> Remplacer les caractères spéciaux — Drive les accepte mais ils posent
> des problèmes dans certains clients Drive (Android notamment).