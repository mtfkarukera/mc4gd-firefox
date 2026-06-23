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

function setTransferState(state, percent) {
  if (state === "downloading" || state === "uploading") {
    isUploading = true;
    progressContainer.classList.remove("hidden");
    progressBar.style.width = percent + "%";
    progressBar.setAttribute("aria-valuenow", percent);
    
    if (state === "downloading") {
      setStatusLive(t("popup_state_downloading", { PERCENT: percent }));
    } else {
      setStatusLive(t("popup_state_uploading", { PERCENT: percent }));
    }
    
    btnSpinner.classList.add("hidden");
    uploadBtn.disabled = false;
    uploadBtn.classList.add("cancel-active");
    btnText.textContent = t("popup_btn_cancel");
    setAuthBadge("loading", t("popup_btn_uploading"));
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
    onboardingOverlay.classList.remove("hidden");
    document.getElementById("onboarding-btn").focus();
  }

  onboardingBtn.addEventListener("click", async () => {
    onboardingOverlay.classList.add("hidden");
    await browser.storage.local.set({ hasSeenWelcome: true });
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

  // État initial : détection en cours
  setAuthBadge("loading", t("popup_auth_loading"));
  setStatusLive(t("popup_detecting"));

  try {
    // Demander au background l'état de l'onglet actif
    const result = await browser.runtime.sendMessage({ action: "getTabStatus" });

    if (result.supported) {
      // Fichier supporté détecté
      fileIcon.textContent = getIconForMime(result.mimeType);
      fileName.textContent = result.fileName;
      fileInfo.classList.remove("warning");
      setAuthBadge("success", t("popup_auth_connected"));
      setStatusLive(t("popup_idle_label"));
      uploadBtn.disabled = false;

    } else {
      // Onglet non éligible
      fileInfo.classList.add("warning");
      uploadBtn.disabled = true;

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
  }
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

      if (response.link && response.link.startsWith("https://drive.google.com/")) {
        driveLink.href = response.link;
        driveLinkRow.classList.remove("hidden");
        driveLink.focus();
      }
    } else {
      setAuthBadge("error", t("popup_auth_error"));
      setStatusLive(response.error);
      uploadBtn.disabled = false;
    }

  } catch (e) {
    setTransferState("idle", 0);
    setAuthBadge("error", t("popup_auth_error"));
    setStatusLive(t("err_upload_failed"));
    uploadBtn.disabled = false;
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

  try {
    await browser.runtime.sendMessage({ action: "disconnect" });
    disconnectBtn.textContent = t("popup_btn_disconnect");
    setAuthBadge("loading", t("popup_auth_loading"));
    setStatusLive(t("popup_auth_loading"));
    driveLinkRow.classList.add("hidden");
    uploadBtn.disabled = true;
  } catch (e) {
    disconnectBtn.textContent = t("popup_btn_disconnect");
    setStatusLive(t("err_network"));
  }
});

// ----------------------------------------------------------
// COMMUNICATOR PROGRESSION
// ----------------------------------------------------------

browser.runtime.onMessage.addListener((message) => {
  if (message.action === "uploadProgress") {
    setTransferState(message.phase || message.state, message.percent);
  }
});
