/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// ============================================================
// Magic Clipper for Google Drive — background.js (Event Page)
// Auth OAuth2 + détection format + dossier Drive + upload résumable chunké
// ============================================================

import { FOLDER_NAME, MIME_MAP, initI18n, t, getFileNameFromUrl } from "../shared/utils.js";

// ----------------------------------------------------------
// CONSTANTES
// ----------------------------------------------------------

const CLIENT_ID = "270035285728-p7ssnc4jqitu5d12j5kuouinirf7vfnf.apps.googleusercontent.com";
const SCOPES    = "https://www.googleapis.com/auth/drive";
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 Mo
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 Mo — multiple de 256 Ko (exigence Google Drive API)
const DOWNLOAD_TIMEOUT_MS = 120_000;  // 2 min
const UPLOAD_CHUNK_TIMEOUT_MS = 60_000; // 1 min par chunk
const CLEANUP_DELAY_MS = 30_000; // 30s
const TOKEN_SAFETY_MARGIN_MS = 120_000; // 2 min
const UPLOAD_SPEED_ESTIMATE_MS_PER_MB = 3000; // 3s par Mo (estimation conservatrice)
const SESSION_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000; // 6 jours (Google expire à 7)
const NETWORK_RETRY_COUNT = 3;
const NETWORK_RETRY_BASE_DELAY_MS = 2000;

// Table inversée : mimeType → extension (pour HEAD fallback)
const MIME_TO_EXT = Object.fromEntries(
  Object.entries(MIME_MAP).map(([ext, mime]) => [mime, ext])
);

// Stockage mémoire des transferts en cours par tabId
const activeUploads = {};

// ----------------------------------------------------------
// MUTEX DE CRÉATION DE DOSSIER
// ----------------------------------------------------------

let folderCreationPromise = null;

// ----------------------------------------------------------
// INITIALISATION i18n (T-01 — attendre avant traitement messages)
// ----------------------------------------------------------

const i18nReady = initI18n();

// ----------------------------------------------------------
// AUTHENTIFICATION OAuth2
// ----------------------------------------------------------

/**
 * Lance le flux OAuth2 implicite via browser.identity.
 * @param {boolean} interactive — true = popup consent, false = silencieux
 * @returns {Promise<string|null>} Le token ou null si silencieux échoue
 */
async function getAccessToken(interactive = true) {
  const redirectURL = browser.identity.getRedirectURL();
  const authURL =
    "https://accounts.google.com/o/oauth2/auth" +
    "?client_id=" + encodeURIComponent(CLIENT_ID) +
    "&redirect_uri=" + encodeURIComponent(redirectURL) +
    "&response_type=token" +
    "&scope=" + encodeURIComponent(SCOPES);

  try {
    const responseURL = await browser.identity.launchWebAuthFlow({
      url: authURL,
      interactive: interactive
    });
    const params = new URLSearchParams(new URL(responseURL).hash.slice(1));
    const token = params.get("access_token");
    if (!token) {
      if (!interactive) return null;
      throw new Error("AUTH_NO_TOKEN");
    }
    const expiresIn = parseInt(params.get("expires_in"), 10) || 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    await browser.storage.local.set({ accessToken: token, expiresAt });
    return token;
  } catch (e) {
    if (!interactive) return null;
    throw e;
  }
}

/**
 * Retourne un token valide : cache → silencieux → interactif.
 */
async function getValidToken() {
  const { accessToken, expiresAt } = await browser.storage.local.get(["accessToken", "expiresAt"]);

  // Token encore valide (marge de sécurité : 2 min)
  if (accessToken && expiresAt > Date.now() + TOKEN_SAFETY_MARGIN_MS) {
    return accessToken;
  }

  // Tentative silencieuse d'abord (pas de popup)
  const silentToken = await getAccessToken(false);
  if (silentToken) return silentToken;

  // Flux interactif uniquement en dernier recours
  return getAccessToken(true);
}

/**
 * Vérifie si un tableau de 4 octets correspond à une plage IPv4 privée ou loopback.
 * @param {number[]|string[]} p — Tableau de 4 entiers (octets IPv4)
 * @returns {boolean}
 */
function isPrivateIPv4Parts(p) {
  const [p0, p1] = [parseInt(p[0], 10), parseInt(p[1], 10)];
  if (isNaN(p0) || isNaN(p1)) return false;
  if (p0 === 127) return true;                          // 127.0.0.0/8 Loopback
  if (p0 === 10) return true;                           // 10.0.0.0/8 Private
  if (p0 === 172 && p1 >= 16 && p1 <= 31) return true; // 172.16.0.0/12 Private
  if (p0 === 192 && p1 === 168) return true;            // 192.168.0.0/16 Private
  if (p0 === 169 && p1 === 254) return true;            // 169.254.0.0/16 Link-local
  if (p0 === 0) return true;                            // 0.0.0.0/8 Broadcast
  return false;
}

/**
 * Vérifie si l'URL pointe vers une adresse IP loopback, privée ou de réseau local (SSRF).
 * Couvre aussi les IPv4-mapped IPv6 (::ffff:192.168.1.1).
 * @param {string} urlStr — L'URL à valider
 * @returns {boolean} true si l'adresse est privée, loopback ou locale
 */
function isPrivateOrLoopback(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();

    // 1. Noms d'hôtes locaux/boucle de retour
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".localhost")) {
      return true;
    }

    // 2. IPv6 (enclos d'une URL : [::1])
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      const ipv6 = hostname.slice(1, -1);
      if (ipv6 === "::1" || ipv6 === "0:0:0:0:0:0:0:1") return true;
      // Link-local fe80::/10
      if (ipv6.startsWith("fe8") || ipv6.startsWith("fe9") ||
          ipv6.startsWith("fea") || ipv6.startsWith("feb")) return true;
      // Unique Local Address fc00::/7
      if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) return true;

      // IPv4-mapped IPv6 : ::ffff:x.x.x.x ou ::ffff:xxxx:xxxx (H-1)
      if (ipv6.startsWith("::ffff:")) {
        const ipv4Part = ipv6.slice(7); // "192.168.1.1" ou "c0a8:0101"
        if (ipv4Part.includes(".")) {
          // Format décimal pointé : ::ffff:192.168.1.1
          return isPrivateIPv4Parts(ipv4Part.split("."));
        }
        if (ipv4Part.includes(":")) {
          // Format hexadécimal : ::ffff:c0a8:0101
          const hex = ipv4Part.replace(":", "");
          return isPrivateIPv4Parts([
            parseInt(hex.slice(0, 2), 16),
            parseInt(hex.slice(2, 4), 16),
            parseInt(hex.slice(4, 6), 16),
            parseInt(hex.slice(6, 8), 16)
          ]);
        }
        return true; // Forme non reconnue → rejeter par précaution
      }

      return false;
    }

    // 3. IPv4 (dotted decimal normalisé par new URL)
    const parts = hostname.split(".");
    if (parts.length === 4) {
      return isPrivateIPv4Parts(parts);
    }

    return false;
  } catch (e) {
    // Si URL non valide, on rejette par sécurité
    return true;
  }
}

/**
 * Effectue un fetch avec une expiration (timeout).
 * @param {string} url - L'URL à requêter
 * @param {Object} options - Options fetch
 * @param {number} timeoutMs - Délai d'expiration en ms
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const { signal } = controller;

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error("TIMEOUT");
    }
    throw error;
  }
}

/**
 * Effectue une requête vers l'API Google Drive avec retries sur les codes d'erreur temporaires et le timeout.
 */
async function fetchDriveWithRetry(url, options = {}, retries = 3, delay = 1000) {
  try {
    const res = await fetchWithTimeout(url, options);
    if (!res.ok) {
      const status = res.status;
      // Codes réessayables : rate limits (429) et erreurs serveur (5xx)
      if ((status === 429 || (status >= 500 && status < 600)) && retries > 0) {
        console.warn(`Drive API returned ${status}. Retrying in ${delay}ms... (Remaining retries: ${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchDriveWithRetry(url, options, retries - 1, delay * 2);
      }
    }
    return res;
  } catch (error) {
    if (error.message === "TIMEOUT" && retries > 0) {
      console.warn(`Drive API request timed out. Retrying in ${delay}ms... (Remaining retries: ${retries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchDriveWithRetry(url, options, retries - 1, delay * 2);
    }
    throw error;
  }
}

/**
 * Centralise la récupération de l'onglet actif dans la fenêtre courante.
 * @returns {Promise<Object|null>} L'onglet actif ou null
 */
async function getActiveTab() {
  try {
    const tabs = await browser.tabs.query({ currentWindow: true, active: true });
    return tabs[0] || null;
  } catch (e) {
    return null;
  }
}

/**
 * Vérifie si la réponse de l'API Drive est en erreur, et lève une exception typée si c'est le cas.
 * @param {Response} res — Objet Response de fetch
 * @param {boolean} isUploadInit — Vrai s'il s'agit de l'init de l'upload résumable (404 signifie RETRY_404)
 */
async function throwIfDriveError(res, isUploadInit = false) {
  if (res.ok) return;
  const status = res.status;
  if (status === 401) throw new Error("RETRY_401");
  if (status === 404) {
    if (isUploadInit) throw new Error("RETRY_404");
    throw new Error(`DRIVE_API_ERROR_HTTP_404`);
  }
  if (status === 403) {
    await parseAndThrowDriveError(res);
  }
  if (status >= 500) throw new Error("GOOGLE_SERVER_ERROR");
  throw new Error(`DRIVE_API_ERROR_HTTP_${status}`);
}

/**
 * Analyse une réponse d'erreur de l'API Drive pour lancer une exception typée.
 */
async function parseAndThrowDriveError(res) {
  const status = res.status;
  let reason = `HTTP_${status}`;
  try {
    const err = await res.json();
    const firstError = err.error?.errors?.[0];
    if (firstError) {
      reason = firstError.reason || firstError.message || reason;
    } else if (err.error?.message) {
      reason = err.error.message;
    }
  } catch (e) {
    // Body isn't JSON — fall through to generic HTTP_${status} error
  }

  if (reason === "storageQuotaExceeded") {
    throw new Error("QUOTA_EXCEEDED");
  }
  if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
    throw new Error("RATE_LIMIT_EXCEEDED");
  }
  throw new Error(reason);
}

// ----------------------------------------------------------
// DÉTECTION DU FORMAT DE FICHIER
// ----------------------------------------------------------

/**
 * Analyse l'onglet actif pour déterminer s'il contient un fichier supporté.
 * Étape 1 : parse l'extension depuis l'URL → MIME_MAP
 * Étape 2 : HEAD request fallback si aucune extension reconnue
 * Ne télécharge jamais le corps du fichier.
 *
 * @param {Object} tab — objet tab Firefox { url, title }
 * @returns {Promise<Object>} { supported, fileName, mimeType, reason? }
 */
async function detectFileFromTab(tab) {
  const url = tab.url || "";
  const title = tab.title || "";

  // Blocage fichiers locaux — définitif
  if (url.startsWith("file://")) {
    return { supported: false, reason: "local_file" };
  }

  // Blocage adresses privées / loopback (SSRF)
  if (isPrivateOrLoopback(url)) {
    return { supported: false, reason: "private_network" };
  }

  // Blocage pages système (about:, moz-extension:, etc.)
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { supported: false, reason: "system_page" };
  }

  // --- Étape 1 : extension dans l'URL ---
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").pop();
    const dotIndex = lastSegment.lastIndexOf(".");
    if (dotIndex > 0) {
      const ext = lastSegment.substring(dotIndex + 1).toLowerCase();
      if (MIME_MAP[ext]) {
        const fileName = getFileNameFromUrl(url, title);
        return { supported: true, fileName, mimeType: MIME_MAP[ext] };
      }
    }
  } catch (e) {
    // URL invalide — continuer vers HEAD fallback
  }

  // --- Étape 2 : HEAD request fallback ---
  try {
    const headRes = await fetchWithTimeout(url, { method: "HEAD" });
    if (headRes.ok) {
      // Vérifier la taille avant tout (limite rehaussée à 200 Mo pour résumable)
      const contentLengthHeader = headRes.headers.get("Content-Length");
      if (contentLengthHeader) {
        const size = parseInt(contentLengthHeader, 10);
        if (!isNaN(size) && size > MAX_FILE_SIZE) {
          return { supported: false, reason: "file_too_large" };
        }
      }

      const contentType = (headRes.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (contentType && MIME_TO_EXT[contentType]) {
        const ext = MIME_TO_EXT[contentType];
        let fileName = getFileNameFromUrl(url, title);
        // S'assurer que le nom a une extension
        if (!fileName.includes(".")) {
          fileName = fileName + "." + ext;
        }
        return { supported: true, fileName, mimeType: contentType };
      }
    }
  } catch (e) {
    // Erreur réseau sur HEAD — on considère non supporté
  }

  return { supported: false, reason: "unsupported_type" };
}

// ----------------------------------------------------------
// GESTION DU DOSSIER DRIVE
// ----------------------------------------------------------

/**
 * Recherche le dossier "Imports Magic Clipper" dans Drive.
 * Prend le plus récent si plusieurs existent (orderBy=createdTime desc).
 * @returns {Promise<string|null>} L'ID du dossier ou null
 */
async function findFolder(token) {
  const safeFolderName = FOLDER_NAME.replace(/'/g, "\\'");
  const q = `name='${safeFolderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url =
    "https://www.googleapis.com/drive/v3/files" +
    "?q=" + encodeURIComponent(q) +
    "&orderBy=createdTime+desc" +
    "&pageSize=1" +
    "&fields=files(id,name)";

  const res = await fetchDriveWithRetry(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  await throwIfDriveError(res);


  const data = await res.json();
  return data.files?.[0]?.id ?? null;
}

async function createFolder(token) {
  const res = await fetchDriveWithRetry("https://www.googleapis.com/drive/v3/files", {
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

  await throwIfDriveError(res);


  const data = await res.json();
  if (!data.id) {
    throw new Error("CREATE_FOLDER_FAILED");
  }
  await browser.storage.local.set({ folderId: data.id });
  return data.id;
}

async function getOrCreateFolder(token) {
  if (folderCreationPromise) {
    await folderCreationPromise;
  }

  const { folderId } = await browser.storage.local.get("folderId");
  if (folderId) return folderId;

  folderCreationPromise = (async () => {
    const found = await findFolder(token);
    if (found) {
      await browser.storage.local.set({ folderId: found });
      return found;
    }
    return createFolder(token);
  })();

  try {
    return await folderCreationPromise;
  } finally {
    folderCreationPromise = null;
  }
}

// ----------------------------------------------------------
// PERSISTANCE DE L'ÉTAT D'UPLOAD (T-09)
// ----------------------------------------------------------

/**
 * Persiste l'état d'upload dans storage.local pour survie au suspend Event Page.
 * Ne contient aucune donnée sensible (le token est déjà sous sa propre clé).
 */
async function persistUploadState(uploadState) {
  await browser.storage.local.set({
    activeUpload: {
      tabId: uploadState.tabId,
      phase: uploadState.phase,
      percent: uploadState.percent,
      fileName: uploadState.fileName,
      mimeType: uploadState.mimeType,
      url: uploadState.url,
      sessionUrl: uploadState.sessionUrl || null,
      bytesUploaded: uploadState.bytesUploaded || 0,
      totalSize: uploadState.totalSize || 0,
      link: uploadState.link || null,
      error: uploadState.error || null,
      startedAt: uploadState.startedAt
    }
  });
}

/**
 * Supprime l'état d'upload persisté.
 */
async function clearPersistedUploadState() {
  await browser.storage.local.remove("activeUpload");
}

// ----------------------------------------------------------
// NETTOYAGE DIFFÉRÉ (DRY — T-13 audit code quality H-13)
// ----------------------------------------------------------

/**
 * Programme la suppression de l'état mémoire après un délai de garde.
 */
function scheduleCleanup(tabId, uploadState) {
  setTimeout(() => {
    if (activeUploads[tabId] === uploadState) {
      delete activeUploads[tabId];
    }
    clearPersistedUploadState().catch(() => {});
  }, CLEANUP_DELAY_MS);
}

// ----------------------------------------------------------
// NOTIFICATION POPUP (helper)
// ----------------------------------------------------------

/**
 * Notifie la popup ouverte d'un changement d'état d'upload.
 * Silencieusement ignoré si la popup est fermée.
 */
function notifyPopup(phase, percent) {
  browser.runtime.sendMessage({
    action: "uploadProgress",
    phase,
    percent
  }).catch(() => {});
}

// ----------------------------------------------------------
// DOWNLOAD AVEC PROGRESSION (ReadableStream)
// ----------------------------------------------------------

/**
 * Télécharge le fichier en calculant son pourcentage de progression.
 * Valide le Content-Type de la réponse (T-03 — F-06).
 *
 * @param {string} url - URL du fichier à télécharger
 * @param {string} expectedMimeType - MIME type attendu (pour validation)
 * @param {number} tabId - ID de l'onglet
 * @param {Object} uploadState - État mutable du transfert
 * @returns {Promise<Blob>} Le contenu du fichier sous forme de Blob
 */
async function downloadFileWithProgress(url, expectedMimeType, tabId, uploadState) {
  const controller = new AbortController();
  uploadState.controller = controller;

  // Auto-timeout for stalled downloads
  const downloadTimeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  const res = await fetch(url, { signal: controller.signal });
  if (!res.ok) {
    clearTimeout(downloadTimeout);
    throw new Error(`DOWNLOAD_FAILED_HTTP_${res.status}`);
  }

  // T-03 (F-06) — Valider le Content-Type de la réponse
  const responseType = (res.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const htmlTypes = ["text/html", "application/xhtml+xml"];
  if (htmlTypes.includes(responseType) && !htmlTypes.includes(expectedMimeType)) {
    clearTimeout(downloadTimeout);
    throw new Error("CONTENT_TYPE_MISMATCH");
  }

  const contentLengthHeader = res.headers.get("Content-Length");
  const totalSize = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

  if (totalSize > MAX_FILE_SIZE) {
    clearTimeout(downloadTimeout);
    throw new Error("FILE_TOO_LARGE");
  }

  const reader = res.body.getReader();
  let receivedLength = 0;
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    receivedLength += value.length;

    if (receivedLength > MAX_FILE_SIZE) {
      clearTimeout(downloadTimeout);
      throw new Error("FILE_TOO_LARGE");
    }

    const percent = totalSize ? Math.round((receivedLength / totalSize) * 100) : 0;
    uploadState.percent = percent;

    // Notifier la popup ouverte
    notifyPopup("downloading", percent);
  }

  clearTimeout(downloadTimeout);

  // T-07 — Construire le Blob puis libérer les chunks immédiatement
  const blob = new Blob(chunks);
  chunks.length = 0; // Libère les références pour le GC

  return blob;
}

// ----------------------------------------------------------
// UPLOAD RÉSUMABLE CHUNKÉ (Google Drive Resumable Session)
// ----------------------------------------------------------

/**
 * Initie une session d'upload résumable sur Google Drive.
 * @returns {Promise<string>} L'URL de session résumable
 */
async function initiateResumableSession(fileName, mimeType, fileSize, token, folderId) {
  const metadata = {
    name: fileName,
    mimeType,
    parents: [folderId]
  };

  const initRes = await fetchDriveWithRetry(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": fileSize.toString()
      },
      body: JSON.stringify(metadata)
    }
  );

  await throwIfDriveError(initRes, true);


  const sessionUrl = initRes.headers.get("Location");
  if (!sessionUrl) {
    throw new Error("SESSION_URL_MISSING");
  }
  return sessionUrl;
}

/**
 * Interroge la session résumable pour connaître les octets déjà reçus.
 * @returns {Promise<number>} Le nombre d'octets déjà confirmés par Google
 */
async function querySessionProgress(sessionUrl, totalSize) {
  const res = await fetchWithTimeout(sessionUrl, {
    method: "PUT",
    headers: {
      "Content-Range": `bytes */${totalSize}`
    }
  }, UPLOAD_CHUNK_TIMEOUT_MS);

  if (res.status === 308) {
    const range = res.headers.get("Range");
    if (range) {
      // Format: "bytes=0-12345"
      const match = range.match(/bytes=0-(\d+)/);
      if (match) return parseInt(match[1], 10) + 1;
    }
    return 0;
  }
  if (res.status === 200 || res.status === 201) {
    // Upload déjà terminé
    return totalSize;
  }
  // Session expirée ou invalide
  throw new Error("SESSION_EXPIRED");
}

/**
 * Upload le fichier par morceaux de CHUNK_SIZE via le protocole résumable.
 * Chaque chunk est envoyé avec un en-tête Content-Range.
 *
 * @param {Blob} fileBlob - Le contenu du fichier
 * @param {string} sessionUrl - URL de session résumable
 * @param {string} mimeType - Type MIME du fichier
 * @param {number} startByte - Octet de reprise (0 pour un nouvel upload)
 * @param {Object} uploadState - État mutable du transfert
 * @returns {Promise<Object>} Réponse JSON de Google (id, name, webViewLink)
 */
async function uploadChunked(fileBlob, sessionUrl, mimeType, startByte, uploadState) {
  const totalSize = fileBlob.size;
  let offset = startByte;

  // AbortController dédié pour la phase upload
  const uploadController = new AbortController();
  uploadState.uploadController = uploadController;

  while (offset < totalSize) {
    // Vérifier annulation avant chaque chunk
    if (uploadController.signal.aborted) {
      throw new Error("ABORTED");
    }

    const end = Math.min(offset + CHUNK_SIZE, totalSize);
    const chunkSlice = fileBlob.slice(offset, end);
    const isLastChunk = (end === totalSize);

    const contentRange = `bytes ${offset}-${end - 1}/${totalSize}`;

    let res;
    let networkRetries = NETWORK_RETRY_COUNT;
    let retryDelay = NETWORK_RETRY_BASE_DELAY_MS;

    // Boucle de retry réseau pour ce chunk (T-11)
    while (true) {
      try {
        res = await fetch(sessionUrl, {
          method: "PUT",
          headers: {
            "Content-Type": mimeType,
            "Content-Range": contentRange
          },
          body: chunkSlice,
          signal: uploadController.signal
        });
        break; // Succès — sortir de la boucle de retry
      } catch (err) {
        if (err.name === "AbortError") {
          throw new Error("ABORTED");
        }
        // Erreur réseau (TypeError dans fetch)
        networkRetries--;
        if (networkRetries <= 0) {
          throw new Error("UPLOAD_NETWORK_ERROR");
        }
        console.warn(`Upload chunk failed (network). Retrying in ${retryDelay}ms... (${networkRetries} retries left)`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay *= 2;

        // Vérifier l'état de la session avant de réessayer
        try {
          const confirmed = await querySessionProgress(sessionUrl, totalSize);
          if (confirmed >= totalSize) {
            // L'upload est déjà terminé côté Google
            return { id: null, name: uploadState.fileName };
          }
          // Ajuster l'offset si Google a reçu plus que prévu
          if (confirmed > offset) {
            offset = confirmed;
          }
        } catch (queryErr) {
          // Impossible de vérifier — on réessaie avec le même offset
        }
      }
    }

    // Traiter la réponse
    if (isLastChunk && (res.status === 200 || res.status === 201)) {
      // Upload terminé — parser la réponse JSON
      try {
        return await res.json();
      } catch (e) {
        return { id: null, name: uploadState.fileName };
      }
    } else if (res.status === 308) {
      // Chunk intermédiaire accepté — continuer
      offset = end;
    } else if (res.status === 200 || res.status === 201) {
      // Google a reçu assez de données et a terminé (fichier petit, dernier chunk)
      try {
        return await res.json();
      } catch (e) {
        return { id: null, name: uploadState.fileName };
      }
    } else if (res.status === 401) {
      throw new Error("RETRY_401");
    } else if (res.status === 404) {
      throw new Error("RETRY_404");
    } else {
      throw new Error(`DRIVE_API_ERROR_HTTP_${res.status}`);
    }

    // Mettre à jour la progression
    uploadState.bytesUploaded = offset;
    const percent = Math.round((offset / totalSize) * 100);
    uploadState.percent = percent;

    // Notifier la popup
    notifyPopup("uploading", percent);

    // Persister l'état après chaque chunk (T-09)
    persistUploadState(uploadState).catch(() => {});
  }

  // Ne devrait pas arriver (boucle terminée sans return)
  throw new Error("UPLOAD_UNEXPECTED_END");
}

/**
 * Upload le fichier vers Google Drive en utilisant le protocole résumable chunké.
 * Gère l'initialisation de session + l'upload par morceaux.
 */
async function uploadFileResumable(fileBlob, fileName, mimeType, token, folderId, tabId, uploadState) {
  // 1. Initialisation de la session d'upload résumable
  const sessionUrl = await initiateResumableSession(fileName, mimeType, fileBlob.size, token, folderId);

  // Persister la session URL pour reprise éventuelle
  uploadState.sessionUrl = sessionUrl;
  uploadState.phase = "uploading";
  uploadState.percent = 0;
  uploadState.totalSize = fileBlob.size;
  uploadState.bytesUploaded = 0;
  await persistUploadState(uploadState);

  // 2. Upload chunké
  return uploadChunked(fileBlob, sessionUrl, mimeType, 0, uploadState);
}

// ----------------------------------------------------------
// UPLOAD AVEC RETRY (401 token expiré, 404 dossier supprimé)
// ----------------------------------------------------------

/**
 * Enveloppe le téléchargement et l'upload résumable avec retry automatique unique.
 * Inclut le rafraîchissement préventif du token (T-13 — F-07).
 */
async function uploadWithRetry(url, fileName, mimeType, tabId, uploadState) {
  let token = await getValidToken();
  let folderId = await getOrCreateFolder(token);

  let fileBlob;
  try {
    // T-03 (F-06) — Passer le expectedMimeType pour validation
    fileBlob = await downloadFileWithProgress(url, mimeType, tabId, uploadState);
  } catch (err) {
    if (err.name === "AbortError" || err.message === "TIMEOUT") {
      throw new Error("TIMEOUT");
    }
    throw err;
  }

  // T-13 (F-07) — Rafraîchir le token préventivement si proche de l'expiration
  const { expiresAt } = await browser.storage.local.get("expiresAt");
  const estimatedUploadMs = (fileBlob.size / (1024 * 1024)) * UPLOAD_SPEED_ESTIMATE_MS_PER_MB;
  if (expiresAt < Date.now() + estimatedUploadMs + TOKEN_SAFETY_MARGIN_MS) {
    await browser.storage.local.remove(["accessToken", "expiresAt"]);
    token = await getValidToken();
  }

  try {
    return await uploadFileResumable(fileBlob, fileName, mimeType, token, folderId, tabId, uploadState);
  } catch (err) {
    // Retry unique sur token expiré
    if (err.message === "RETRY_401") {
      await browser.storage.local.remove(["accessToken", "expiresAt"]);
      token = await getValidToken();
      return await uploadFileResumable(fileBlob, fileName, mimeType, token, folderId, tabId, uploadState);
    }
    // Retry unique sur dossier supprimé
    if (err.message === "RETRY_404") {
      await browser.storage.local.remove("folderId");
      folderId = await getOrCreateFolder(token);
      return await uploadFileResumable(fileBlob, fileName, mimeType, token, folderId, tabId, uploadState);
    }
    throw err;
  }
}

// ----------------------------------------------------------
// DÉCONNEXION
// ----------------------------------------------------------

/**
 * Révoque le token côté Google et purge le stockage local.
 */
async function disconnect() {
  const { accessToken } = await browser.storage.local.get("accessToken");
  if (accessToken) {
    // Révocation best-effort — ne pas bloquer sur l'erreur
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: `token=${encodeURIComponent(accessToken)}`
    }).catch(() => {});
  }
  await browser.storage.local.remove(["accessToken", "expiresAt", "folderId"]);
}

// ----------------------------------------------------------
// MAPPING ERREUR → i18n (DRY — audit M-15)
// ----------------------------------------------------------

const ERROR_I18N_MAP = {
  FILE_TOO_LARGE: "err_file_too_large",

  TIMEOUT: "err_timeout",
  RATE_LIMIT_EXCEEDED: "err_rate_limit",
  GOOGLE_SERVER_ERROR: "err_google_server",
  QUOTA_EXCEEDED: "err_quota",
  ABORTED: "err_upload_aborted",
  CONTENT_TYPE_MISMATCH: "err_content_mismatch",
  UPLOAD_NETWORK_ERROR: "err_network"
};

/**
 * Convertit une erreur interne en message i18n pour l'utilisateur.
 */
function errorToI18nMessage(e) {
  // Lookup direct dans la map
  const mappedKey = ERROR_I18N_MAP[e.message];
  if (mappedKey) return t(mappedKey);

  // Cas spéciaux nécessitant une extraction de données
  if (e.message?.startsWith("DOWNLOAD_FAILED_HTTP_")) {
    const status = e.message.replace("DOWNLOAD_FAILED_HTTP_", "");
    return t("err_download_failed", { STATUS: status });
  }
  if (e.message?.includes("auth") || e.message?.includes("identity")) {
    return t("err_auth_failed");
  }
  if (e.name === "TypeError") {
    return t("err_network");
  }
  return t("err_upload_failed");
}

/**
 * Gère le processus d'upload du fichier de l'onglet actif.
 * @param {Object} tab — L'onglet actif
 * @returns {Promise<Object>} Résultat de l'upload
 */
async function handleUploadCurrentFile(tab) {
  if (!tab || !tab.url) {
    return { success: false, error: "No active tab" };
  }
  const tabId = tab.id;

  // T-02 (F-05) — Garde anti-double upload
  if (activeUploads[tabId]) {
    return { success: false, error: t("err_upload_in_progress") };
  }

  // Détection du format
  const detection = await detectFileFromTab(tab);
  if (!detection.supported) {
    let errorKey = "err_unsupported_type";
    if (detection.reason === "local_file") errorKey = "err_local_file";
    if (detection.reason === "private_network") errorKey = "err_private_network";
    if (detection.reason === "file_too_large") errorKey = "err_file_too_large";
    return { success: false, error: t(errorKey) };
  }

  // Initialiser le suivi du transfert en arrière-plan
  const uploadState = {
    tabId,
    phase: "downloading",
    percent: 0,
    fileName: detection.fileName,
    mimeType: detection.mimeType,
    url: tab.url,
    sessionUrl: null,
    bytesUploaded: 0,
    totalSize: 0,
    controller: null,       // AbortController pour le download
    uploadController: null, // AbortController pour l'upload chunké
    link: null,
    error: null,
    startedAt: Date.now()
  };
  activeUploads[tabId] = uploadState;

  // Persister l'état initial
  await persistUploadState(uploadState);

  try {
    const result = await uploadWithRetry(tab.url, detection.fileName, detection.mimeType, tabId, uploadState);

    const finalLink = result.webViewLink;
    uploadState.phase = "success";
    uploadState.link = finalLink;
    await persistUploadState(uploadState);

    scheduleCleanup(tabId, uploadState);

    const response = { success: true, fileName: result.name, link: finalLink };
    // Notification de secours : si le port sendResponse est fermé (auth longue),
    // la popup recevra le résultat via cet onMessage séparé.
    browser.runtime.sendMessage({
      action: "uploadComplete", ...response
    }).catch(() => {});
    return response;
  } catch (e) {
    const errorMsg = errorToI18nMessage(e);

    uploadState.phase = "error";
    uploadState.error = errorMsg;
    await persistUploadState(uploadState);

    scheduleCleanup(tabId, uploadState);

    const response = { success: false, error: errorMsg };
    browser.runtime.sendMessage({
      action: "uploadComplete", ...response
    }).catch(() => {});
    return response;
  }
}

// ----------------------------------------------------------
// ROUTEUR DE MESSAGES — handleMessage
// ----------------------------------------------------------

/**
 * Traite un message provenant de la popup.
 * @param {Object} message — { action, ... }
 * @returns {Promise<Object>} Réponse à sendResponse
 */
async function handleMessage(message) {
  // T-01 (F-03) — Attendre que l'i18n soit initialisé
  await i18nReady;

  switch (message.action) {

    case "getRedirectURL":
      return { url: browser.identity.getRedirectURL() };

    case "getTabStatus": {
      const tab = await getActiveTab();
      if (!tab || !tab.url) {
        return { supported: false, reason: "system_page" };
      }
      return await detectFileFromTab(tab);
    }

    case "getUploadStatus": {
      const tab = await getActiveTab();
      if (!tab) return null;

      // Vérifier l'état en mémoire d'abord
      let uploadState = activeUploads[tab.id];

      // T-12 — Fallback vers storage.local si le background a été redémarré
      if (!uploadState) {
        const { activeUpload } = await browser.storage.local.get("activeUpload");
        if (activeUpload && activeUpload.tabId === tab.id) {
          uploadState = activeUpload;
        }
      }

      if (!uploadState) return null;

      const result = {
        phase: uploadState.phase,
        percent: uploadState.percent,
        fileName: uploadState.fileName,
        mimeType: uploadState.mimeType,
        link: uploadState.link,
        error: uploadState.error
      };

      // Si l'envoi a fini ou est en échec, on vide l'état après lecture
      if (uploadState.phase === "success" || uploadState.phase === "error") {
        delete activeUploads[tab.id];
        clearPersistedUploadState().catch(() => {});
      }
      return result;
    }

    case "cancelUpload": {
      const tab = await getActiveTab();
      if (!tab) return { success: false };
      const uploadState = activeUploads[tab.id];
      if (uploadState) {
        // Abort download controller
        if (uploadState.controller) {
          uploadState.controller.abort();
        }
        // Abort upload controller (remplace l'ancien xhr.abort)
        if (uploadState.uploadController) {
          uploadState.uploadController.abort();
        }
        delete activeUploads[tab.id];
        clearPersistedUploadState().catch(() => {});
      }
      return { success: true };
    }

    case "uploadCurrentFile": {
      const tab = await getActiveTab();
      if (!tab) {
        return { success: false, error: "No active tab" };
      }
      return await handleUploadCurrentFile(tab);
    }

    case "disconnect":
      await disconnect();
      return { success: true };

    default:
      return { success: false, error: "Unknown action" };
  }
}

// ----------------------------------------------------------
// LISTENER onMessage — FORME ROBUSTE avec return true
// ----------------------------------------------------------

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id) {
    return;
  }
  (async () => {
    const result = await handleMessage(message);
    sendResponse(result);
  })();
  return true; // ← OBLIGATOIRE — maintient le canal ouvert
});

// ----------------------------------------------------------
// NETTOYAGE AUTOMATIQUE — ONGLET FERMÉ
// ----------------------------------------------------------

browser.tabs.onRemoved.addListener((tabId) => {
  const uploadState = activeUploads[tabId];
  if (!uploadState) return;

  // Abort active download
  if (uploadState.controller) {
    uploadState.controller.abort();
  }
  // Abort active upload
  if (uploadState.uploadController) {
    uploadState.uploadController.abort();
  }
  delete activeUploads[tabId];
  clearPersistedUploadState().catch(() => {});
});

// ----------------------------------------------------------
// REPRISE D'UPLOAD AU RÉVEIL DU BACKGROUND (T-10)
// ----------------------------------------------------------

(async () => {
  await i18nReady;

  const { activeUpload } = await browser.storage.local.get("activeUpload");
  if (!activeUpload) return;

  const { tabId, phase, sessionUrl, bytesUploaded, totalSize, startedAt, fileName, mimeType, url } = activeUpload;

  // Sessions trop anciennes — nettoyer
  if (startedAt && (Date.now() - startedAt) > SESSION_MAX_AGE_MS) {
    await clearPersistedUploadState();
    return;
  }

  // Phase downloading — impossible de reprendre un download interrompu
  if (phase === "downloading") {
    activeUpload.phase = "error";
    activeUpload.error = t("err_network");
    activeUploads[tabId] = activeUpload;
    await persistUploadState(activeUpload);
    scheduleCleanup(tabId, activeUpload);
    return;
  }

  // Phase uploading — tenter la reprise si session valide
  if (phase === "uploading" && sessionUrl && totalSize > 0) {
    try {
      const confirmed = await querySessionProgress(sessionUrl, totalSize);

      if (confirmed >= totalSize) {
        // Upload déjà terminé côté Google — marquer comme succès
        activeUpload.phase = "success";
        activeUpload.percent = 100;
        activeUploads[tabId] = activeUpload;
        await persistUploadState(activeUpload);
        scheduleCleanup(tabId, activeUpload);
        return;
      }

      // Session encore active — on doit re-télécharger le fichier pour reprendre
      // (le Blob n'est pas persisté). Marquer comme erreur pour l'instant.
      // L'utilisateur peut relancer manuellement.
      activeUpload.phase = "error";
      activeUpload.error = t("err_network");
      activeUploads[tabId] = activeUpload;
      await persistUploadState(activeUpload);
      scheduleCleanup(tabId, activeUpload);
    } catch (e) {
      // Session expirée ou erreur réseau
      activeUpload.phase = "error";
      activeUpload.error = t("err_upload_failed");
      activeUploads[tabId] = activeUpload;
      await persistUploadState(activeUpload);
      scheduleCleanup(tabId, activeUpload);
    }
    return;
  }

  // Phases success/error — ne rien faire (sera lu par la popup)
  if (phase === "success" || phase === "error") {
    activeUploads[tabId] = activeUpload;
    scheduleCleanup(tabId, activeUpload);
  }
})();
