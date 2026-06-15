# Privacy Policy — Magic Clipper for Google Drive

**Last updated:** 2026-06-15

## 1. No Data Collection
Magic Clipper for Google Drive (MC4GD) does not collect, track, store, or transmit any personal data or browsing history to external or third-party servers. All processing and network requests occur directly from your browser.

## 2. Google Drive Access & Scope Justification
To upload your selected files, the extension requests OAuth 2.0 access to your Google Drive using the full `https://www.googleapis.com/auth/drive` scope. 
* **Why full `drive` scope?** This scope is required to search your Google Drive for any pre-existing `"Imports Magic Clipper"` folder created in previous sessions or on other devices. The narrower `drive.file` scope restricts the extension to only seeing files it created during the current installation/session. Using `drive.file` would make it impossible to detect pre-existing folders, causing duplicate folders to be created.
* **Access limitation**: The extension strictly uses this permission to locate/create the `"Imports Magic Clipper"` folder and upload your selected PDFs, images, or documents. It does not read, modify, or delete any other files in your Google Drive.

## 3. Serverless Architecture
The extension connects directly to Google Drive API v3 endpoints. There are no intermediary or proxy servers. Your files are downloaded from the source tab and uploaded to Google Drive without passing through any third party.

## 4. Local Storage
The OAuth2 access token, token expiration timestamp, the cached Google Drive folder ID, and your manual language selection are stored locally on your device via `browser.storage.local`. This data never leaves your device except to authenticate directly with Google APIs.

## 5. Open Source
This extension is fully open source under the Mozilla Public License 2.0 (MPL-2.0). The complete source code can be reviewed at:
https://github.com/mtfkarukera/mc4gd-firefox

## 6. Contact & Support
For any privacy-related questions or to report issues, please open an issue on our GitHub repository:
https://github.com/mtfkarukera/mc4gd-firefox