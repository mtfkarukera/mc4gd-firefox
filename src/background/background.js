/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// ============================================================
// Magic Clipper for Google Drive — background.js (Event Page)
// Auth OAuth2 + détection format + dossier Drive + upload résumable
// ============================================================

import { FOLDER_NAME, MIME_MAP, initI18n, t, getFileNameFromUrl } from "../shared/utils.js";

// ----------------------------------------------------------
// CONSTANTES
// ----------------------------------------------------------

const CLIENT_ID = "270035285728-p7ssnc4jqitu5d12j5kuouinirf7vfnf.apps.googleusercontent.com";
const SCOPES    = "https://www.googleapis.com/auth/drive";

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
// INITIALISATION i18n
// ----------------------------------------------------------

initI18n();

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
    const expiresIn = parseInt(params.get("expires_in")) || 3600;
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
  if (accessToken && expiresAt > Date.now() + 120_000) {
    return accessToken;
  }

  // Tentative silencieuse d'abord (pas de popup)
  const silentToken = await getAccessToken(false);
  if (silentToken) return silentToken;

  // Flux interactif uniquement en dernier recours
  return getAccessToken(true);
}

/**
 * Vérifie si l'URL pointe vers une adresse IP loopback, privée ou de réseau local (SSRF).
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
      if (ipv6.startsWith("fe8") || ipv6.startsWith("fe9") || ipv6.startsWith("fea") || ipv6.startsWith("feb")) return true;
      // Unique Local Address fc00::/7
      if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) return true;
      return false;
    }

    // 3. IPv4 (dotted decimal normalisé par new URL)
    const parts = hostname.split(".");
    if (parts.length === 4) {
      const p0 = parseInt(parts[0], 10);
      const p1 = parseInt(parts[1], 10);

      if (isNaN(p0) || isNaN(p1)) return false;

      // 127.0.0.0/8 (Loopback)
      if (p0 === 127) return true;
      // 10.0.0.0/8 (Private network)
      if (p0 === 10) return true;
      // 172.16.0.0/12 (Private network)
      if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
      // 192.168.0.0/16 (Private network)
      if (p0 === 192 && p1 === 168) return true;
      // 169.254.0.0/16 (Link-local, ex: metadata cloud provider)
      if (p0 === 169 && p1 === 254) return true;
      // 0.0.0.0/8 (Broadcast/Current network)
      if (p0 === 0) return true;
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
    // Échec de parsing
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
        if (!isNaN(size) && size > 200 * 1024 * 1024) {
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
  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url =
    "https://www.googleapis.com/drive/v3/files" +
    "?q=" + encodeURIComponent(q) +
    "&orderBy=createdTime+desc" +
    "&pageSize=1" +
    "&fields=files(id,name)";

  const res = await fetchDriveWithRetry(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const status = res.status;
    if (status === 401) throw new Error("RETRY_401");
    if (status === 403) {
      await parseAndThrowDriveError(res);
    }
    if (status >= 500) throw new Error("GOOGLE_SERVER_ERROR");
    throw new Error(`DRIVE_API_ERROR_HTTP_${status}`);
  }

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

  if (!res.ok) {
    const status = res.status;
    if (status === 401) throw new Error("RETRY_401");
    if (status === 403) {
      await parseAndThrowDriveError(res);
    }
    if (status >= 500) throw new Error("GOOGLE_SERVER_ERROR");
    throw new Error(`DRIVE_API_ERROR_HTTP_${status}`);
  }

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
// DOWNLOAD AVEC PROGRESSION (ReadableStream)
// ----------------------------------------------------------

/**
 * Télécharge le fichier en calculant son pourcentage de progression.
 */
async function downloadFileWithProgress(url, tabId, uploadState) {
  const controller = new AbortController();
  uploadState.controller = controller;

  const res = await fetch(url, { signal: controller.signal });
  if (!res.ok) {
    throw new Error(`DOWNLOAD_FAILED_HTTP_${res.status}`);
  }

  const contentLengthHeader = res.headers.get("Content-Length");
  const totalSize = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

  if (totalSize > 200 * 1024 * 1024) {
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

    if (receivedLength > 200 * 1024 * 1024) {
      throw new Error("FILE_TOO_LARGE");
    }

    const percent = totalSize ? Math.round((receivedLength / totalSize) * 100) : 0;
    uploadState.percent = percent;

    // Notifier la popup ouverte
    browser.runtime.sendMessage({
      action: "uploadProgress",
      state: "downloading",
      percent
    }).catch(() => {});
  }

  return new Blob(chunks);
}

// ----------------------------------------------------------
// UPLOAD RÉSUMABLE (Google Drive Resumable Session)
// ----------------------------------------------------------

/**
 * Upload le fichier vers Google Drive en utilisant une session d'upload résumable
 * et XMLHttpRequest pour suivre le téléversement.
 */
async function uploadFileResumable(fileBlob, fileName, mimeType, token, folderId, tabId, uploadState) {
  // 1. Initialisation de la session d'upload
  const metadata = {
    name: fileName,
    mimeType: mimeType,
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
        "X-Upload-Content-Length": fileBlob.size.toString()
      },
      body: JSON.stringify(metadata)
    }
  );

  if (!initRes.ok) {
    const status = initRes.status;
    if (status === 401) throw new Error("RETRY_401");
    if (status === 404) throw new Error("RETRY_404");
    await parseAndThrowDriveError(initRes);
  }

  const sessionUrl = initRes.headers.get("Location");
  if (!sessionUrl) {
    throw new Error("SESSION_URL_MISSING");
  }

  // 2. Transfert du contenu via XMLHttpRequest PUT (progress monitoring)
  const xhr = new XMLHttpRequest();
  uploadState.xhr = xhr;
  uploadState.state = "uploading";
  uploadState.percent = 0;

  const uploadPromise = new Promise((resolve, reject) => {
    xhr.open("PUT", sessionUrl);
    xhr.setRequestHeader("Content-Type", mimeType);

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        uploadState.percent = percent;

        // Notifier la popup ouverte
        browser.runtime.sendMessage({
          action: "uploadProgress",
          state: "uploading",
          percent
        }).catch(() => {});
      }
    });

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          resolve({ id: null, name: fileName });
        }
      } else {
        const status = xhr.status;
        if (status === 401) reject(new Error("RETRY_401"));
        else if (status === 404) reject(new Error("RETRY_404"));
        else reject(new Error(`DRIVE_API_ERROR_HTTP_${status}`));
      }
    };

    xhr.onerror = () => reject(new Error("UPLOAD_NETWORK_ERROR"));
    xhr.onabort = () => reject(new Error("ABORTED"));
  });

  xhr.send(fileBlob);
  return uploadPromise;
}

// ----------------------------------------------------------
// UPLOAD AVEC RETRY (401 token expiré, 404 dossier supprimé)
// ----------------------------------------------------------

/**
 * Enveloppe le téléchargement et l'upload résumable avec retry automatique unique.
 */
async function uploadWithRetry(url, fileName, mimeType, tabId, uploadState) {
  let token = await getValidToken();
  let folderId = await getOrCreateFolder(token);

  let fileBlob;
  try {
    fileBlob = await downloadFileWithProgress(url, tabId, uploadState);
  } catch (err) {
    if (err.name === "AbortError" || err.message === "TIMEOUT") {
      throw new Error("TIMEOUT");
    }
    throw err;
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
// ROUTEUR DE MESSAGES — handleMessage
// ----------------------------------------------------------

/**
 * Traite un message provenant de la popup.
 * @param {Object} message — { action, ... }
 * @returns {Promise<Object>} Réponse à sendResponse
 */
async function handleMessage(message) {
  switch (message.action) {

    case "getRedirectURL":
      return { url: browser.identity.getRedirectURL() };

    case "getTabStatus": {
      try {
        const tabs = await browser.tabs.query({ currentWindow: true, active: true });
        const tab = tabs[0];
        if (!tab || !tab.url) {
          return { supported: false, reason: "system_page" };
        }
        return await detectFileFromTab(tab);
      } catch (e) {
        return { supported: false, reason: "system_page" };
      }
    }

    case "getUploadStatus": {
      try {
        const tabs = await browser.tabs.query({ currentWindow: true, active: true });
        const tab = tabs[0];
        if (!tab) return null;
        const uploadState = activeUploads[tab.id];
        if (!uploadState) return null;

        const result = {
          state: uploadState.state,
          percent: uploadState.percent,
          fileName: uploadState.fileName,
          mimeType: uploadState.mimeType,
          link: uploadState.link,
          error: uploadState.error
        };

        // Si l'envoi a fini ou est en échec, on vide l'état après lecture
        if (uploadState.state === "success" || uploadState.state === "error") {
          delete activeUploads[tab.id];
        }
        return result;
      } catch (e) {
        return null;
      }
    }

    case "cancelUpload": {
      try {
        const tabs = await browser.tabs.query({ currentWindow: true, active: true });
        const tab = tabs[0];
        if (!tab) return { success: false };
        const uploadState = activeUploads[tab.id];
        if (uploadState) {
          if (uploadState.xhr) {
            uploadState.xhr.abort();
          }
          if (uploadState.controller) {
            uploadState.controller.abort();
          }
          delete activeUploads[tab.id];
        }
        return { success: true };
      } catch (e) {
        return { success: false };
      }
    }

    case "uploadCurrentFile": {
      const tabs = await browser.tabs.query({ currentWindow: true, active: true });
      const tab = tabs[0];
      if (!tab) {
        return { success: false, error: "No active tab" };
      }
      const tabId = tab.id;

      // Détection du format
      const detection = await detectFileFromTab(tab);
      if (!detection.supported) {
        let errorKey = "err_unsupported_type";
        if (detection.reason === "local_file") errorKey = "err_local_file";
        if (detection.reason === "private_network") errorKey = "err_private_network";
        if (detection.reason === "file_too_large") errorKey = "err_file_too_large_50";
        return { success: false, error: t(errorKey) };
      }

      // Initialiser le suivi du transfert en arrière-plan
      const uploadState = {
        state: "downloading",
        percent: 0,
        fileName: detection.fileName,
        mimeType: detection.mimeType,
        xhr: null,
        controller: null,
        link: null,
        error: null
      };
      activeUploads[tabId] = uploadState;

      try {
        const result = await uploadWithRetry(tab.url, detection.fileName, detection.mimeType, tabId, uploadState);

        const finalLink = result.webViewLink;
        uploadState.state = "success";
        uploadState.link = finalLink;

        // Vider la mémoire après 30s de garde si la popup n'a pas lu le statut
        setTimeout(() => {
          if (activeUploads[tabId] === uploadState) {
            delete activeUploads[tabId];
          }
        }, 30000);

        return { success: true, fileName: result.name, link: finalLink };
      } catch (e) {
        if (e.message === "ABORTED") {
          uploadState.state = "error";
          uploadState.error = t("err_upload_aborted");
          setTimeout(() => {
            if (activeUploads[tabId] === uploadState) delete activeUploads[tabId];
          }, 30000);
          return { success: false, error: t("err_upload_aborted") };
        }

        let errorMsg = t("err_upload_failed");
        if (e.message === "FILE_TOO_LARGE") {
          errorMsg = t("err_file_too_large_50");
        } else if (e.message === "TIMEOUT") {
          errorMsg = t("err_timeout");
        } else if (e.message === "RATE_LIMIT_EXCEEDED") {
          errorMsg = t("err_rate_limit");
        } else if (e.message === "GOOGLE_SERVER_ERROR") {
          errorMsg = t("err_google_server");
        } else if (e.message === "QUOTA_EXCEEDED") {
          errorMsg = t("err_quota");
        } else if (e.message?.startsWith("DOWNLOAD_FAILED_HTTP_")) {
          const status = e.message.replace("DOWNLOAD_FAILED_HTTP_", "");
          errorMsg = t("err_download_failed", { STATUS: status });
        } else if (e.message?.includes("auth") || e.message?.includes("identity")) {
          errorMsg = t("err_auth_failed");
        } else if (e.name === "TypeError") {
          errorMsg = t("err_network");
        }

        uploadState.state = "error";
        uploadState.error = errorMsg;

        setTimeout(() => {
          if (activeUploads[tabId] === uploadState) delete activeUploads[tabId];
        }, 30000);

        return { success: false, error: errorMsg };
      }
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
