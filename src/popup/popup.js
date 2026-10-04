/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Magic Clipper for Google Drive — popup.js
// Logique UI — machine à états + messaging background + progression
// ============================================================

import { initI18n, t, currentLocale } from "../shared/utils.js";

// ----------------------------------------------------------
// ICÔNE MIME — locale à popup.js
// ----------------------------------------------------------

function getIconForMime(mimeType) {
  if (!mimeType) return "📎";
  if (mimeType === "application/pdf") return "📄";
  if (mimeType.startsWith("image/")) return "🖼️";
  if (mimeType.startsWith("audio/")) return "🎵";
  if (mimeType.startsWith("video/")) return "🎬";
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "📝";
  return "📎";
}

// ----------------------------------------------------------
// RÉFÉRENCES DOM
// ----------------------------------------------------------

const uploadBtn         = document.getElementById('upload-btn');
const authStatus        = document.getElementById('auth-status');
const fileInfo          = document.getElementById('file-info');
const fileIcon          = document.getElementById('file-icon');
const fileName          = document.getElementById('file-name');
const driveLinkRow      = document.getElementById('drive-link-row');
const driveLink         = document.getElementById('drive-link');
const connectBtn        = document.getElementById('connect-btn');
const disconnectBtn     = document.getElementById('disconnect-btn');
const statusMessage     = document.getElementById('status-message');
const btnSpinner        = document.getElementById('btn-spinner');
const btnText           = uploadBtn.querySelector('.btn-text');
const langSelect        = document.getElementById('lang-select');
const onboardingOverlay = document.getElementById('onboarding-overlay');
const onboardingBtn     = document.getElementById('onboarding-btn');
const progressContainer = document.getElementById('progress-container');
const progressBar       = document.getElementById('progress-bar');

// --- Éléments de la section capture (Sprint 16) ---
const directUploadSection     = document.getElementById('direct-upload-section');
const captureSection          = document.getElementById('capture-section');
const capturePdfBtn           = document.getElementById('capture-pdf-btn');
const captureMdBtn            = document.getElementById('capture-md-btn');
const captureProgressContainer = document.getElementById('capture-progress-container');
const captureProgressBar      = document.getElementById('capture-progress-bar');
const captureLinkRow          = document.getElementById('capture-link-row');
const captureLink             = document.getElementById('capture-link');

// #file-icon contient des emoji décoratifs — masquer aux lecteurs d'écran (A-05)
fileIcon.setAttribute('aria-hidden', 'true');

let isUploading = false;
let transferStartedAt = 0;

function formatSpeed(bytesPerSec) {
  if (bytesPerSec >= 1024 * 1024) {
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + " Mo/s";
  }
  return (bytesPerSec / 1024).toFixed(0) + " Ko/s";
}

function formatETA(secs) {
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  const remainingSecs = secs % 60;
  return mins + "m " + remainingSecs + "s";
}

// ----------------------------------------------------------
// HELPERS UI
// ----------------------------------------------------------

// ARIA live region update
function setStatusLive(msg) {
  statusMessage.textContent = msg;
}

function setAuthBadge(state, label) {
  authStatus.className = "status-badge status-" + state;
  authStatus.textContent = label;
}

/**
 * Met à jour la visibilité des boutons Se connecter / Déconnecter selon l'état d'authentification.
 * @param {boolean} isAuthenticated — true si un accessToken existe
 */
function updateAuthButtonsVisibility(isAuthenticated) {
  if (isAuthenticated) {
    connectBtn.classList.add("hidden");
    disconnectBtn.classList.remove("hidden");
  } else {
    connectBtn.classList.remove("hidden");
    disconnectBtn.classList.add("hidden");
  }
}
// Rétrocompatibilité interne
const updateDisconnectVisibility = updateAuthButtonsVisibility;

// Throttle des annonces de progression (A-07) — toutes les 10%
let lastAnnouncedPercent = -1;
let currentAnnouncedPhase = null;

function setTransferState(phase, percent, bytesTransferred = 0, totalBytes = 0) {
  if (phase === "downloading" || phase === "uploading") {
    if (transferStartedAt === 0) {
      transferStartedAt = Date.now();
    }

    const clampedPercent = Math.min(100, Math.max(0, percent ?? 0));

    isUploading = true;
    progressContainer.classList.remove("hidden");
    progressBar.style.width = clampedPercent + "%";
    progressBar.setAttribute("aria-valuenow", clampedPercent);

    // Calculer l'ETA et la vitesse si données suffisantes
    let statusText = "";
    const elapsedMs = Date.now() - transferStartedAt;
    if (bytesTransferred > 0 && totalBytes > 0 && elapsedMs > 1000) {
      const speedBytesPerSec = bytesTransferred / (elapsedMs / 1000);
      if (speedBytesPerSec > 0) {
        const remainingSecs = Math.max(0, Math.round((totalBytes - bytesTransferred) / speedBytesPerSec));
        const speedStr = formatSpeed(speedBytesPerSec);
        const etaStr = formatETA(remainingSecs);

        if (phase === "downloading") {
          statusText = t("popup_state_downloading_eta", { PERCENT: clampedPercent, ETA: etaStr, SPEED: speedStr });
        } else {
          statusText = t("popup_state_uploading_eta", { PERCENT: clampedPercent, ETA: etaStr, SPEED: speedStr });
        }
      }
    }

    // Fallback si pas d'ETA
    if (!statusText) {
      if (phase === "downloading") {
        statusText = t("popup_state_downloading", { PERCENT: clampedPercent });
      } else {
        statusText = t("popup_state_uploading", { PERCENT: clampedPercent });
      }
    }

    // Annonce live throttlée : seulement si changement de phase ou palier de 10%
    const bucket = Math.floor((percent ?? 0) / 10) * 10;
    if (phase !== currentAnnouncedPhase || bucket > lastAnnouncedPercent) {
      // A11y-01 : Annoncer le passage en mode annulation de bouton une fois au début
      if (currentAnnouncedPhase === null) {
        setStatusLive(t("popup_state_action_cancel_announce") + " " + statusText);
      } else {
        setStatusLive(statusText);
      }
      lastAnnouncedPercent = bucket;
      currentAnnouncedPhase = phase;
    }

    btnSpinner.classList.add("hidden");
    uploadBtn.disabled = false;
    uploadBtn.classList.add("cancel-active");
    btnText.textContent = t("popup_btn_cancel");
    setAuthBadge("loading", t("popup_btn_uploading"));
    // Masquer Déconnecter et Se connecter pendant un transfert
    disconnectBtn.classList.add("hidden");
    connectBtn.classList.add("hidden");
  } else {
    isUploading = false;
    transferStartedAt = 0;
    progressContainer.classList.add("hidden");
    progressBar.style.width = "0%";
    progressBar.setAttribute("aria-valuenow", 0);
    uploadBtn.classList.remove("cancel-active");
    btnSpinner.classList.add("hidden");
    btnText.textContent = t("popup_btn_upload");
  }
}

// ----------------------------------------------------------
// INTERNATIONALISATION — data-i18n
// ----------------------------------------------------------

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach(el => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  });
  document.documentElement.lang = currentLocale;
}

// ----------------------------------------------------------
// FOCUS TRAP — dialog d'onboarding (A-01)
// ----------------------------------------------------------

/**
 * Piège le focus dans un dialog : Tab/Shift+Tab bouclent dans les éléments focusables.
 * @param {HTMLElement} dialogEl — L'élément dialog
 * @returns {Function} Fonction de nettoyage (remove listener)
 */
function trapFocus(dialogEl) {
  const focusableSelectors = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])'
  ].join(", ");

  const focusable = Array.from(dialogEl.querySelectorAll(focusableSelectors));
  if (focusable.length === 0) return () => {};

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  function onKeyDown(e) {
    if (e.key !== "Tab") return;
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  dialogEl.addEventListener("keydown", onKeyDown);
  return () => dialogEl.removeEventListener("keydown", onKeyDown);
}

// Variable pour stocker la fonction de nettoyage du trap
let releaseTrap = null;
// Élément qui avait le focus avant l'ouverture du dialog
let focusBeforeDialog = null;

/**
 * Ferme le dialog d'onboarding, relâche le focus trap, restaure le focus. (A-02)
 */
async function closeOnboarding() {
  onboardingOverlay.classList.add("hidden");
  await browser.storage.local.set({ hasSeenWelcome: true });
  if (releaseTrap) {
    releaseTrap();
    releaseTrap = null;
  }
  // Restaurer le focus vers l'élément qui le détenait avant, ou le bouton d'upload
  if (focusBeforeDialog && typeof focusBeforeDialog.focus === "function") {
    focusBeforeDialog.focus();
  } else {
    uploadBtn.focus();
  }
}

// ----------------------------------------------------------
// DÉTECTION D'ONGLET — réutilisable au démarrage et post-déconnexion
// ----------------------------------------------------------

/**
 * Interroge le background sur l'état de l'onglet actif et met à jour l'interface.
 * Vérifie également si un accessToken est présent pour le badge d'authentification.
 * Gère 3 modes : fichier direct, page web capturable, page non supportée.
 */
async function initTabStatus() {
  setAuthBadge('loading', t('popup_auth_loading'));
  setStatusLive(t('popup_detecting'));

  // 1. Déterminer et mettre à jour le statut d'authentification
  let hasToken = false;
  try {
    const { accessToken } = await browser.storage.local.get('accessToken');
    if (accessToken) {
      setAuthBadge('success', t('popup_auth_connected'));
      updateDisconnectVisibility(true);
      hasToken = true;
    } else {
      setAuthBadge('disconnected', t('popup_auth_disconnected'));
      updateDisconnectVisibility(false);
    }
  } catch (e) {
    setAuthBadge('error', t('popup_auth_error'));
    updateDisconnectVisibility(false);
  }

  // 2. Déterminer l'éligibilité du fichier sur l'onglet actif
  try {
    const result = await browser.runtime.sendMessage({ action: 'getTabStatus' });

    if (result.supported) {
      // --- MODE FICHIER DIRECT (existant, inchangé) ---
      directUploadSection.classList.remove('hidden');
      captureSection.classList.add('hidden');
      fileIcon.textContent = getIconForMime(result.mimeType);
      fileName.textContent = result.fileName;
      fileInfo.classList.remove('warning');
      uploadBtn.disabled = false;
      if (hasToken) {
        setStatusLive(t('popup_idle_label'));
      } else {
        setStatusLive(t('popup_disconnected_status'));
      }
    } else if (result.reason === 'local_file' || result.reason === 'private_network' || result.reason === 'file_too_large') {
      // --- MODE ERREUR SPÉCIFIQUE (existant, inchangé) ---
      directUploadSection.classList.remove('hidden');
      captureSection.classList.add('hidden');
      fileInfo.classList.add('warning');
      uploadBtn.disabled = true;
      if (result.reason === 'local_file') {
        fileName.textContent = t('popup_local_file');
        setStatusLive(t('err_local_file'));
      } else if (result.reason === 'private_network') {
        fileName.textContent = t('popup_unsupported');
        setStatusLive(t('err_private_network'));
      } else {
        fileName.textContent = t('popup_unsupported');
        setStatusLive(t('err_file_too_large'));
      }
    } else if (result.reason === 'system_page') {
      // --- MODE PAGE SYSTÈME (about:*, moz-extension:*) ---
      directUploadSection.classList.add('hidden');
      captureSection.classList.add('hidden');
      fileInfo.classList.add('warning');
      fileName.textContent = t('popup_unsupported');
      setStatusLive(t('popup_unsupported'));
    } else {
      // --- MODE CAPTURE DE PAGE WEB (NOUVEAU) ---
      // Aucun fichier détectable → proposer la capture
      directUploadSection.classList.add('hidden');
      captureSection.classList.remove('hidden');
      fileInfo.classList.remove('warning');
      fileIcon.textContent = '🌐';
      fileName.textContent = t('popup_web_page') || 'Page web détectée';
      capturePdfBtn.disabled = false;
      captureMdBtn.disabled  = false;
      if (hasToken) {
        setStatusLive(t('popup_capture_ready') || 'Capture de page disponible');
      } else {
        setStatusLive(t('popup_disconnected_status_web'));
      }
    }
  } catch (e) {
    fileInfo.classList.add('warning');
    fileName.textContent = t('popup_no_file');
    setStatusLive(t('err_network'));
  }
}

// ----------------------------------------------------------
// INITIALISATION
// ----------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  // Lire la locale persistée
  const stored = await browser.storage.local.get(["locale", "hasSeenWelcome"]);
  const savedLocale = stored.locale || "auto";
  langSelect.value = savedLocale;
  await initI18n(savedLocale === "auto" ? null : savedLocale);

  // Appliquer les traductions sur tous les attributs data-i18n
  applyI18n();

  // Gérer l'onboarding
  if (!stored.hasSeenWelcome) {
    focusBeforeDialog = document.activeElement;
    onboardingOverlay.classList.remove("hidden");
    onboardingBtn.focus();
    // Activer le focus trap (A-01)
    releaseTrap = trapFocus(onboardingOverlay);
  }

  // Bouton "J'ai compris" de l'onboarding
  onboardingBtn.addEventListener("click", closeOnboarding);

  // Fermeture par Escape (A-02)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !onboardingOverlay.classList.contains("hidden")) {
      e.preventDefault();
      e.stopPropagation();
      closeOnboarding();
    }
  });

  // Reconnexion : demander au background s'il y a un upload actif pour cet onglet
  try {
    const uploadStatus = await browser.runtime.sendMessage({ action: "getUploadStatus" });
    const uploadPhase = uploadStatus && (uploadStatus.phase || uploadStatus.state);
    if (uploadPhase === "downloading" || uploadPhase === "uploading") {
      fileIcon.textContent = getIconForMime(uploadStatus.mimeType);
      fileName.textContent = uploadStatus.fileName;
      fileInfo.classList.remove("warning");
      setTransferState(uploadPhase, uploadStatus.percent);
      return;
    }
  } catch (e) {
    // Continuer vers l'init standard en cas d'erreur
  }

  // Détection initiale de l'onglet
  await initTabStatus();
});

// ----------------------------------------------------------
// SÉLECTEUR DE LANGUE
// ----------------------------------------------------------

langSelect.addEventListener("change", async () => {
  const newLocale = langSelect.value;
  await browser.storage.local.set({ locale: newLocale });
  await initI18n(newLocale === "auto" ? null : newLocale);
  applyI18n();
});

// ----------------------------------------------------------
// UPLOAD / ANNULATION — clic sur le bouton principal
// ----------------------------------------------------------

uploadBtn.addEventListener('click', async () => {
  if (isUploading) {
    // Action d'annulation
    uploadBtn.disabled = true;
    try {
      await browser.runtime.sendMessage({ action: 'cancelUpload' });
    } catch (e) {
      // Ignorer
    }
    return;
  }

  // Réinitialiser le throttle de progression (A-07)
  lastAnnouncedPercent = -1;
  currentAnnouncedPhase = null;

  // Action d'envoi
  isUploading = true;
  isProcessingResult = false;
  driveLinkRow.classList.add('hidden');
  setTransferState('downloading', 0);

  try {
    const response = await browser.runtime.sendMessage({ action: 'uploadCurrentFile' });
    isProcessingResult = true;

    setTransferState('idle', 0);

    if (response.success) {
      setAuthBadge('success', t('popup_auth_connected'));
      setStatusLive(t('popup_success', { FILE_NAME: response.fileName }));
      uploadBtn.disabled = true;
      updateDisconnectVisibility(true);

      if (response.link && response.link.startsWith('https://drive.google.com/')) {
        driveLink.href = response.link;
        driveLinkRow.classList.remove('hidden');
        driveLink.focus();
      }

      // UX-01 : Permettre le ré-upload après un succès en réactivant le bouton après 5 secondes
      setTimeout(() => {
        uploadBtn.disabled = false;
      }, 5000);
    } else {
      // Afficher l'erreur EN PREMIER pour éviter qu'un setTransferState ultérieur ne l'écrase
      setAuthBadge('error', t('popup_auth_error'));
      setStatusLive(response.error);
      uploadBtn.disabled = false;
      // Vérifier l'auth pour décider de la visibilité du bouton déconnexion
      const { accessToken } = await browser.storage.local.get('accessToken');
      updateDisconnectVisibility(!!accessToken);
    }

  } catch (e) {
    setTransferState('idle', 0);
    setAuthBadge('error', t('popup_auth_error'));
    setStatusLive(t('err_upload_failed'));
    uploadBtn.disabled = false;
    updateDisconnectVisibility(false);
  }
});

// ----------------------------------------------------------
// CAPTURE DE PAGE WEB — clic sur les boutons PDF/MD
// ----------------------------------------------------------

let isCapturing = false;

async function startCapture(format) {
  if (isCapturing || isUploading) return;

  isCapturing = true;
  isProcessingResult = false;
  capturePdfBtn.disabled = true;
  captureMdBtn.disabled  = true;
  captureLinkRow.classList.add('hidden');
  captureProgressContainer.classList.remove('hidden');
  captureProgressBar.style.width = '0%';
  setStatusLive(t('popup_capture_in_progress') || 'Capture en cours...');
  setAuthBadge('loading', t('popup_btn_uploading'));

  try {
    const response = await browser.runtime.sendMessage({
      action: 'captureWebPage',
      format: format
    });

    if (!response.success) {
      // Erreur immédiate (page restreinte, etc.)
      isCapturing = false;
      captureProgressContainer.classList.add('hidden');
      setAuthBadge('error', t('popup_auth_error'));
      setStatusLive(response.error);
      capturePdfBtn.disabled = false;
      captureMdBtn.disabled  = false;
    }
    // Sinon, le résultat arrivera via uploadComplete (asynchrone)
  } catch (e) {
    isCapturing = false;
    captureProgressContainer.classList.add('hidden');
    setAuthBadge('error', t('popup_auth_error'));
    setStatusLive(t('err_upload_failed'));
    capturePdfBtn.disabled = false;
    captureMdBtn.disabled  = false;
  }
}

capturePdfBtn.addEventListener('click', () => startCapture('pdf'));
captureMdBtn.addEventListener('click', () => startCapture('md'));

// ----------------------------------------------------------
// DÉCONNEXION — double-clic avec timer (confirm() interdit MV3)
// ----------------------------------------------------------

let disconnectPending = false;
let disconnectTimer = null;

disconnectBtn.addEventListener("click", async () => {
  if (!disconnectPending) {
    // Premier clic : passer en état de confirmation
    disconnectPending = true;
    disconnectBtn.textContent = t("popup_btn_disconnect_confirm");
    disconnectBtn.classList.add("confirm-active");
    // Annoncer le changement à la live region (A-03)
    setStatusLive(t("popup_disconnect_confirm_announce"));
    disconnectTimer = setTimeout(() => {
      disconnectPending = false;
      disconnectBtn.textContent = t("popup_btn_disconnect");
      disconnectBtn.classList.remove("confirm-active");
    }, 3000);
    return;
  }

  // Second clic dans les 3s : exécuter la déconnexion
  clearTimeout(disconnectTimer);
  disconnectPending = false;
  disconnectBtn.classList.remove("confirm-active");
  disconnectBtn.textContent = t("popup_btn_disconnect");

  // Rendre la déconnexion synchrone pour purger storage.local avant ré-initialisation
  try {
    await browser.runtime.sendMessage({ action: "disconnect" });
  } catch (e) {
    // Ignorer
  }

  // Mise à jour synchrone de l'interface
  driveLinkRow.classList.add("hidden");
  setTransferState("idle", 0);
  setAuthBadge("disconnected", t("popup_auth_disconnected"));
  setStatusLive(t("popup_disconnected_status"));
  updateDisconnectVisibility(false);

  // UX-02 : Réinitialisation complète de l'état du fichier après déconnexion
  await initTabStatus();
});

// ----------------------------------------------------------
// CONNEXION — clic sur le bouton Se connecter
// ----------------------------------------------------------

connectBtn.addEventListener("click", async () => {
  connectBtn.disabled = true;
  setAuthBadge("loading", t("popup_auth_loading"));
  setStatusLive(t("popup_auth_loading"));

  try {
    const response = await browser.runtime.sendMessage({ action: "login" });
    if (response.success) {
      setAuthBadge("success", t("popup_auth_connected"));
      updateAuthButtonsVisibility(true);
      await initTabStatus();
    } else {
      setAuthBadge("disconnected", t("popup_auth_disconnected"));
      setStatusLive(response.error || t("popup_auth_error"));
      updateAuthButtonsVisibility(false);
    }
  } catch (err) {
    setAuthBadge("error", t("popup_auth_error"));
    setStatusLive(t("err_network"));
    updateAuthButtonsVisibility(false);
  } finally {
    connectBtn.disabled = false;
  }
});

let isProcessingResult = false;

// ----------------------------------------------------------
// COMMUNICATOR PROGRESSION — messages du background
// ----------------------------------------------------------

browser.runtime.onMessage.addListener((message) => {
  if (message.action === 'uploadProgress') {
    const phase = message.phase || message.state;

    // Progression du mode capture : utiliser la barre de progression capture
    if (isCapturing) {
      captureProgressBar.style.width = (message.percent || 0) + '%';
      captureProgressBar.setAttribute('aria-valuenow', message.percent || 0);
      if (phase === 'uploading') {
        setStatusLive(t('popup_state_uploading', { PERCENT: message.percent || 0 }));
      }
    } else {
      setTransferState(phase, message.percent, message.bytesTransferred, message.totalBytes);
    }
  }

  // Message de fin d'upload envoyé par le background (fallback si sendMessage non lu)
  if (message.action === 'uploadComplete') {
    if (isProcessingResult) return;
    isProcessingResult = true;

    if (isCapturing) {
      // --- Mode capture ---
      isCapturing = false;
      captureProgressContainer.classList.add('hidden');

      if (message.success) {
        setAuthBadge('success', t('popup_auth_connected'));
        setStatusLive(t('popup_success', { FILE_NAME: message.fileName }));
        capturePdfBtn.disabled = true;
        captureMdBtn.disabled  = true;
        updateDisconnectVisibility(true);

        if (message.link && message.link.startsWith('https://drive.google.com/')) {
          captureLink.href = message.link;
          captureLinkRow.classList.remove('hidden');
          captureLink.focus();
        }

        // Permettre une nouvelle capture après 5 secondes
        setTimeout(() => {
          capturePdfBtn.disabled = false;
          captureMdBtn.disabled  = false;
        }, 5000);
      } else {
        setAuthBadge('error', t('popup_auth_error'));
        setStatusLive(message.error || t('err_upload_failed'));
        capturePdfBtn.disabled = false;
        captureMdBtn.disabled  = false;
        browser.storage.local.get('accessToken').then(({ accessToken }) => {
          updateDisconnectVisibility(!!accessToken);
        });
      }
    } else {
      // --- Mode fichier direct (existant, inchangé) ---
      setTransferState('idle', 0);
      if (message.success) {
        setAuthBadge('success', t('popup_auth_connected'));
        setStatusLive(t('popup_success', { FILE_NAME: message.fileName }));
        uploadBtn.disabled = true;
        updateDisconnectVisibility(true);
        if (message.link && message.link.startsWith('https://drive.google.com/')) {
          driveLink.href = message.link;
          driveLinkRow.classList.remove('hidden');
          driveLink.focus();
        }

        // UX-01 : Permettre le ré-upload après un succès en réactivant le bouton après 5 secondes
        setTimeout(() => {
          uploadBtn.disabled = false;
        }, 5000);
      } else {
        setAuthBadge('error', t('popup_auth_error'));
        setStatusLive(message.error || t('err_upload_failed'));
        uploadBtn.disabled = false;
        browser.storage.local.get('accessToken').then(({ accessToken }) => {
          updateDisconnectVisibility(!!accessToken);
        });
      }
    }
  }
});
