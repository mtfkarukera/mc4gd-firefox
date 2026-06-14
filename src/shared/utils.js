/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const FOLDER_NAME = "Imports Magic Clipper";

export const MIME_MAP = {
  "pdf": "application/pdf",
  "png": "image/png",
  "jpg": "image/jpeg",
  "jpeg": "image/jpeg",
  "gif": "image/gif",
  "webp": "image/webp",
  "svg": "image/svg+xml",
  "avif": "image/avif",
  "bmp": "image/bmp",
  "ico": "image/x-icon",
  "tiff": "image/tiff",
  "mp3": "audio/mpeg",
  "mp4": "video/mp4",
  "webm": "video/webm",
  "ogg": "audio/ogg",
  "wav": "audio/wav",
  "aac": "audio/aac",
  "flac": "audio/flac",
  "m4a": "audio/mp4",
  "mov": "video/quicktime",
  "mpeg": "video/mpeg",
  "txt": "text/plain",
  "md": "text/markdown",
  "csv": "text/csv",
  "json": "application/json",
  "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "zip": "application/zip",
  "tar": "application/x-tar",
  "gz": "application/gzip",
  "epub": "application/epub+zip"
};

let messages = {};
let fallbackMessages = {};
export let currentLocale = "en";

export async function initI18n(forcedLocale = null) {
  try {
    const fallbackRes = await fetch(browser.runtime.getURL("_locales/en/messages.json"));
    fallbackMessages = await fallbackRes.json();
  } catch (e) {
    console.warn("Failed to load fallback locale 'en'", e);
  }

  let locale;
  if (forcedLocale && forcedLocale !== "auto") {
    locale = forcedLocale;
  } else {
    locale = browser.i18n.getUILanguage().split('-')[0];
  }

  const allowedLocales = ["en", "fr", "de", "es", "vi", "gcf"];
  if (!allowedLocales.includes(locale)) {
    locale = "en";
  }
  currentLocale = locale;

  if (locale === 'en') {
    messages = fallbackMessages;
    return;
  }

  try {
    const res = await fetch(browser.runtime.getURL(`_locales/${locale}/messages.json`));
    if (res.ok) {
      messages = await res.json();
    } else {
      messages = fallbackMessages;
    }
  } catch (e) {
    console.warn(`Failed to load locale '${locale}', falling back to 'en'`);
    messages = fallbackMessages;
  }
}

export function t(key, substitutions) {
  const item = messages[key] || fallbackMessages[key];
  if (!item || !item.message) return key;

  let text = item.message;
  if (substitutions) {
    for (const [k, v] of Object.entries(substitutions)) {
      text = text.replaceAll(`$${k}$`, v);
    }
  }
  return text;
}

export function getFileNameFromUrl(url, title) {
  try {
    const parsed = new URL(url);
    const lastPart = parsed.pathname.split('/').pop();
    if (lastPart && lastPart.includes('.')) {
      const ext = lastPart.split('.').pop().toLowerCase();
      if (MIME_MAP[ext]) {
        const decoded = decodeURIComponent(lastPart);
        return decoded.replace(/[<>:"/\\|?*]/g, '_');
      }
    }
  } catch (e) {
    // Invalid URL
  }

  if (title) {
    const cleanTitle = title.replace(/[<>:"/\\|?*]/g, '_').trim();
    if (cleanTitle) {
      return cleanTitle;
    }
  }

  return "file";
}
