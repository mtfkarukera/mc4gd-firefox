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

const uploadBtn         = document.getElementById("upload-btn");
const authStatus        = document.getElementById("auth-status");
const fileInfo          = document.getElementById("file-info");
const fileIcon          = document.getElementById("file-icon");
const fileName          = document.getElementById("file-name");
const driveLinkRow      = document.getElementById("drive-link-row");
const driveLink         = document.getElementById("drive-link");
const disconnectBtn     = document.getElementById("disconnect-btn");
const statusMessage     = document.getElementById("status-message");
const btnSpinner        = document.getElementById("btn-spinner");
const btnText           = uploadBtn.querySelector(".btn-text");
const langSelect        = document.getElementById("lang-select");
const onboardingOverlay = document.getElementById("onboarding-overlay");
const onboardingBtn     = document.getElementById("onboarding-btn");
const progressContainer = document.getElementById("progress-container");
const progressBar       = document.getElementById("progress-bar");

// #file-icon contient des emoji décoratifs — masquer aux lecteurs d'écran (A-05)
fileIcon.setAttribute("aria-hidden", "true");

let isUploading = false;

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
 * Met à jour la visibilité du bouton Déconnecter selon l'état d'authentification.
 * @param {boolean} isAuthenticated — true si un accessToken existe
 */
function updateDisconnectVisibility(isAuthenticated) {
  if (isAuthenticated) {
    disconnectBtn.classList.remove("hidden");
  } else {
    disconnectBtn.classList.add("hidden");
  }
}

// Throttle des annonces de progression (A-07) — toutes les 10%
let lastAnnouncedPercent = -1;
let currentAnnouncedPhase = null;

function setTransferState(phase, percent) {
  if (phase === "downloading" || phase === "uploading") {
    isUploading = true;
    progressContainer.classList.remove("hidden");
    progressBar.style.width = percent + "%";
    progressBar.setAttribute("aria-valuenow", percent);

    // Annonce live throttlée : seulement si changement de phase ou palier de 10%
    const bucket = Math.floor((percent ?? 0) / 10) * 10;
    if (phase !== currentAnnouncedPhase || bucket > lastAnnouncedPercent) {
      if (phase === "downloading") {
        setStatusLive(t("popup_state_downloading", { PERCENT: percent }));
      } else {
        setStatusLive(t("popup_state_uploading", { PERCENT: percent }));
      }
      lastAnnouncedPercent = bucket;
      currentAnnouncedPhase = phase;
    }

    btnSpinner.classList.add("hidden");
    uploadBtn.disabled = false;
    uploadBtn.classList.add("cancel-active");
    btnText.textContent = t("popup_btn_cancel");
    setAuthBadge("loading", t("popup_btn_uploading"));
    // Masquer Déconnecter pendant un transfert
    disconnectBtn.classList.add("hidden");
  } else {
    isUploading = false;
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
 */
async function initTabStatus() {
  setAuthBadge("loading", t("popup_auth_loading"));
  setStatusLive(t("popup_detecting"));

  try {
    const result = await browser.runtime.sendMessage({ action: "getTabStatus" });

    if (result.supported) {
      fileIcon.textContent = getIconForMime(result.mimeType);
      fileName.textContent = result.fileName;
      fileInfo.classList.remove("warning");

      // Vérifier si l'utilisateur est authentifié (accessToken en storage)
      const { accessToken } = await browser.storage.local.get("accessToken");
      if (accessToken) {
        setAuthBadge("success", t("popup_auth_connected"));
        setStatusLive(t("popup_idle_label"));
        updateDisconnectVisibility(true);
      } else {
        setAuthBadge("disconnected", t("popup_auth_disconnected"));
        setStatusLive(t("popup_disconnected_status"));
        updateDisconnectVisibility(false);
      }
      uploadBtn.disabled = false;

    } else {
      fileInfo.classList.add("warning");
      uploadBtn.disabled = true;
      updateDisconnectVisibility(false);

      if (result.reason === "local_file") {
        fileName.textContent = t("popup_local_file");
        setStatusLive(t("err_local_file"));
      } else if (result.reason === "private_network") {
        fileName.textContent = t("popup_unsupported");
        setStatusLive(t("err_private_network"));
      } else if (result.reason === "file_too_large") {
        fileName.textContent = t("popup_unsupported");
        setStatusLive(t("err_file_too_large_50"));
      } else if (result.reason === "system_page") {
        fileName.textContent = t("popup_unsupported");
        setStatusLive(t("popup_unsupported"));
      } else {
        fileName.textContent = t("popup_no_file");
        setStatusLive(t("popup_unsupported"));
      }

      setAuthBadge("error", t("popup_auth_error"));
    }

  } catch (e) {
    fileInfo.classList.add("warning");
    fileName.textContent = t("popup_no_file");
    setAuthBadge("error", t("popup_auth_error"));
    setStatusLive(t("err_network"));
    updateDisconnectVisibility(false);
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

uploadBtn.addEventListener("click", async () => {
  if (isUploading) {
    // Action d'annulation
    uploadBtn.disabled = true;
    try {
      await browser.runtime.sendMessage({ action: "cancelUpload" });
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
  driveLinkRow.classList.add("hidden");
  setTransferState("downloading", 0);

  try {
    const response = await browser.runtime.sendMessage({ action: "uploadCurrentFile" });

    setTransferState("idle", 0);

    if (response.success) {
      setAuthBadge("success", t("popup_auth_connected"));
      setStatusLive(t("popup_success", { FILE_NAME: response.fileName }));
      uploadBtn.disabled = true;
      updateDisconnectVisibility(true);

      if (response.link && response.link.startsWith("https://drive.google.com/")) {
        driveLink.href = response.link;
        driveLinkRow.classList.remove("hidden");
        driveLink.focus();
      }
    } else {
      setAuthBadge("error", t("popup_auth_error"));
      setStatusLive(response.error);
      uploadBtn.disabled = false;
      // Vérifier l'auth pour décider de la visibilité du bouton déconnexion
      const { accessToken } = await browser.storage.local.get("accessToken");
      updateDisconnectVisibility(!!accessToken);
    }

  } catch (e) {
    setTransferState("idle", 0);
    setAuthBadge("error", t("popup_auth_error"));
    setStatusLive(t("err_upload_failed"));
    uploadBtn.disabled = false;
    updateDisconnectVisibility(false);
  }
});

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

  // Fire-and-forget — la révocation token est best-effort côté background.
  browser.runtime.sendMessage({ action: "disconnect" }).catch(() => {});

  // Mise à jour synchrone de l'interface
  driveLinkRow.classList.add("hidden");
  setTransferState("idle", 0);
  setAuthBadge("disconnected", t("popup_auth_disconnected"));
  setStatusLive(t("popup_disconnected_status"));
  updateDisconnectVisibility(false);
  uploadBtn.disabled = false;
});

// ----------------------------------------------------------
// COMMUNICATOR PROGRESSION — messages du background
// ----------------------------------------------------------

browser.runtime.onMessage.addListener((message) => {
  if (message.action === "uploadProgress") {
    const phase = message.phase || message.state;
    setTransferState(phase, message.percent);
  }
  // Message de fin d'upload envoyé par le background
  if (message.action === "uploadComplete") {
    setTransferState("idle", 0);
    if (message.success) {
      setAuthBadge("success", t("popup_auth_connected"));
      setStatusLive(t("popup_success", { FILE_NAME: message.fileName }));
      uploadBtn.disabled = true;
      updateDisconnectVisibility(true);
      if (message.link && message.link.startsWith("https://drive.google.com/")) {
        driveLink.href = message.link;
        driveLinkRow.classList.remove("hidden");
        driveLink.focus();
      }
    } else {
      setAuthBadge("error", t("popup_auth_error"));
      setStatusLive(message.error || t("err_upload_failed"));
      uploadBtn.disabled = false;
      browser.storage.local.get("accessToken").then(({ accessToken }) => {
        updateDisconnectVisibility(!!accessToken);
      });
    }
  }
});
