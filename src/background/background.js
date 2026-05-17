// ============================================================
// Magic Clipper for Google Drive — background.js (Event Page)
// Auth OAuth2 + détection format + dossier Drive + upload
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
    const headRes = await fetch(url, { method: "HEAD" });
    if (headRes.ok) {
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
    "&fields=files(id,name)";

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    throw new Error(`Recherche dossier Drive échouée (HTTP ${res.status})`);
  }

  const data = await res.json();
  return data.files?.[0]?.id ?? null;
}

/**
 * Crée le dossier "Imports Magic Clipper" à la racine du Drive.
 * @returns {Promise<string>} L'ID du dossier créé
 */
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
  if (!data.id) {
    throw new Error("Création du dossier Drive échouée.");
  }
  await browser.storage.local.set({ folderId: data.id });
  return data.id;
}

/**
 * Orchestrateur : cache → findFolder → createFolder.
 */
async function getOrCreateFolder(token) {
  // Vérifier le cache d'abord
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

// ----------------------------------------------------------
// UPLOAD FICHIER — MULTIPART (≤ 5 Mo)
// ----------------------------------------------------------

/**
 * Télécharge le fichier depuis l'URL puis l'upload en multipart vers Drive.
 *
 * @param {string} url       — URL du fichier à télécharger
 * @param {string} fileName  — Nom du fichier dans Drive
 * @param {string} mimeType  — Type MIME du fichier
 * @param {string} token     — Token OAuth2
 * @param {string} folderId  — ID du dossier parent Drive
 * @returns {Promise<{id, name, webViewLink}>}
 */
async function uploadFile(url, fileName, mimeType, token, folderId) {
  // Téléchargement du fichier depuis l'URL de l'onglet
  const fileResponse = await fetch(url);
  if (!fileResponse.ok) {
    throw new Error(`HTTP_${fileResponse.status}`);
  }
  const fileBlob = await fileResponse.blob();

  // Metadata Drive
  const metadata = {
    name: fileName,
    mimeType: mimeType,
    parents: [folderId]
  };

  // Corps multipart
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", fileBlob);

  // Upload
  const uploadRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form
    }
  );

  if (!uploadRes.ok) {
    const status = uploadRes.status;
    if (status === 401) throw new Error("RETRY_401");
    if (status === 404) throw new Error("RETRY_404");
    if (status === 403) throw new Error("QUOTA_EXCEEDED");
    const err = await uploadRes.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP_${status}`);
  }

  return uploadRes.json();
}

// ----------------------------------------------------------
// UPLOAD AVEC RETRY (401 token expiré, 404 dossier supprimé)
// ----------------------------------------------------------

/**
 * Enveloppe uploadFile avec retry automatique unique.
 */
async function uploadWithRetry(url, fileName, mimeType) {
  let token = await getValidToken();
  let folderId = await getOrCreateFolder(token);

  try {
    return await uploadFile(url, fileName, mimeType, token, folderId);
  } catch (err) {
    // Retry unique sur token expiré
    if (err.message === "RETRY_401") {
      await browser.storage.local.remove(["accessToken", "expiresAt"]);
      token = await getValidToken();
      return await uploadFile(url, fileName, mimeType, token, folderId);
    }
    // Retry unique sur dossier supprimé
    if (err.message === "RETRY_404") {
      await browser.storage.local.remove("folderId");
      folderId = await getOrCreateFolder(token);
      return await uploadFile(url, fileName, mimeType, token, folderId);
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
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${accessToken}`).catch(() => {});
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

    case "uploadCurrentFile": {
      try {
        // Récupère l'onglet actif
        const tabs = await browser.tabs.query({ currentWindow: true, active: true });
        const tab = tabs[0];

        // Détection du format
        const detection = await detectFileFromTab(tab);
        if (!detection.supported) {
          const errorKey = detection.reason === "local_file" ? "err_local_file" : "err_unsupported_type";
          return { success: false, error: t(errorKey) };
        }

        // Upload avec retry automatique
        const result = await uploadWithRetry(tab.url, detection.fileName, detection.mimeType);

        return { success: true, fileName: result.name, link: result.webViewLink };
      } catch (e) {
        // Messages d'erreur i18n selon le type
        if (e.message === "QUOTA_EXCEEDED") {
          return { success: false, error: t("err_quota") };
        }
        if (e.message?.startsWith("HTTP_")) {
          const status = e.message.replace("HTTP_", "");
          return { success: false, error: t("err_download_failed", { STATUS: status }) };
        }
        if (e.message?.includes("auth") || e.message?.includes("identity")) {
          return { success: false, error: t("err_auth_failed") };
        }
        // Erreur réseau (fetch échoue sans status)
        if (e.name === "TypeError" && e.message?.includes("fetch")) {
          return { success: false, error: t("err_network") };
        }
        return { success: false, error: t("err_upload_failed") };
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
  (async () => {
    const result = await handleMessage(message);
    sendResponse(result);
  })();
  return true; // ← OBLIGATOIRE — maintient le canal ouvert
});
