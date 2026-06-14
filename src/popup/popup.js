// ============================================================
// Magic Clipper for Google Drive — popup.js
// Logique UI — machine à états + messaging background
// ============================================================

import { initI18n, t } from "../shared/utils.js";

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

const uploadBtn     = document.getElementById("upload-btn");
const authStatus    = document.getElementById("auth-status");
const fileInfo      = document.getElementById("file-info");
const fileIcon      = document.getElementById("file-icon");
const fileName      = document.getElementById("file-name");
const driveLinkRow  = document.getElementById("drive-link-row");
const driveLink     = document.getElementById("drive-link");
const disconnectBtn = document.getElementById("disconnect-btn");
const statusMessage = document.getElementById("status-message");
const btnSpinner    = document.getElementById("btn-spinner");
const btnText       = uploadBtn.querySelector(".btn-text");
const langSelect    = document.getElementById("lang-select");

// ----------------------------------------------------------
// HELPERS UI
// ----------------------------------------------------------

function setStatus(msg) {
  statusMessage.textContent = msg;
}

function setAuthBadge(state, label) {
  authStatus.className = "status-badge status-" + state;
  authStatus.textContent = label;
}

function setLoading(loading) {
  uploadBtn.disabled = loading;
  btnSpinner.classList.toggle("hidden", !loading);
  btnText.textContent = loading ? t("popup_btn_uploading") : t("popup_btn_upload");
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
}

// ----------------------------------------------------------
// INITIALISATION
// ----------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  // Lire la locale persistée
  const stored = await browser.storage.local.get("locale");
  const savedLocale = stored.locale || "auto";
  langSelect.value = savedLocale;
  await initI18n(savedLocale === "auto" ? null : savedLocale);

  // Appliquer les traductions sur tous les attributs data-i18n
  applyI18n();

  // État initial : détection en cours
  setAuthBadge("loading", t("popup_auth_loading"));
  setStatus(t("popup_detecting"));

  try {
    // Demander au background l'état de l'onglet actif
    const result = await browser.runtime.sendMessage({ action: "getTabStatus" });

    if (result.supported) {
      // Fichier supporté détecté
      fileIcon.textContent = getIconForMime(result.mimeType);
      fileName.textContent = result.fileName;
      fileInfo.classList.remove("warning");
      setAuthBadge("success", t("popup_auth_connected"));
      setStatus(t("popup_idle_label"));
      uploadBtn.disabled = false;

    } else {
      // Onglet non éligible
      fileInfo.classList.add("warning");
      uploadBtn.disabled = true;

      if (result.reason === "local_file") {
        fileName.textContent = t("popup_local_file");
        setStatus(t("err_local_file"));
      } else if (result.reason === "private_network") {
        fileName.textContent = t("popup_unsupported");
        setStatus(t("err_private_network"));
      } else if (result.reason === "file_too_large") {
        fileName.textContent = t("popup_unsupported");
        setStatus(t("err_file_too_large"));
      } else if (result.reason === "system_page") {
        fileName.textContent = t("popup_unsupported");
        setStatus(t("popup_unsupported"));
      } else {
        fileName.textContent = t("popup_no_file");
        setStatus(t("popup_unsupported"));
      }

      setAuthBadge("error", t("popup_auth_error"));
    }

  } catch (e) {
    fileInfo.classList.add("warning");
    fileName.textContent = t("popup_no_file");
    setAuthBadge("error", t("popup_auth_error"));
    setStatus(t("err_network"));
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
// UPLOAD — clic sur le bouton principal
// ----------------------------------------------------------

uploadBtn.addEventListener("click", async () => {
  setLoading(true);
  driveLinkRow.classList.add("hidden");
  setStatus(t("popup_uploading_label"));
  setAuthBadge("loading", t("popup_btn_uploading"));

  try {
    const response = await browser.runtime.sendMessage({ action: "uploadCurrentFile" });

    setLoading(false);

    if (response.success) {
      setAuthBadge("success", t("popup_auth_connected"));
      setStatus(t("popup_success", { FILE_NAME: response.fileName }));
      uploadBtn.disabled = true;

      if (response.link && response.link.startsWith("https://drive.google.com/")) {
        driveLink.href = response.link;
        driveLinkRow.classList.remove("hidden");
      }
    } else {
      setAuthBadge("error", t("popup_auth_error"));
      setStatus(response.error);
      uploadBtn.disabled = false;
    }

  } catch (e) {
    setLoading(false);
    setAuthBadge("error", t("popup_auth_error"));
    setStatus(t("err_upload_failed"));
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
    disconnectBtn.textContent = t("popup_confirm_disconnect");
    disconnectTimer = setTimeout(() => {
      disconnectPending = false;
      disconnectBtn.textContent = t("popup_btn_disconnect");
    }, 3000);
    return;
  }

  // Second clic dans les 3s : exécuter la déconnexion
  clearTimeout(disconnectTimer);
  disconnectPending = false;

  try {
    await browser.runtime.sendMessage({ action: "disconnect" });
    disconnectBtn.textContent = t("popup_btn_disconnect");
    setAuthBadge("loading", t("popup_auth_loading"));
    setStatus(t("popup_auth_loading"));
    driveLinkRow.classList.add("hidden");
    uploadBtn.disabled = true;
  } catch (e) {
    disconnectBtn.textContent = t("popup_btn_disconnect");
    setStatus(t("err_network"));
  }
});
