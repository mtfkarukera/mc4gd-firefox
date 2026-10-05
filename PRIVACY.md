# Privacy Policy — Magic Clipper for Google Drive

**Last updated:** October 2026

## 1. No Data Collection
Magic Clipper for Google Drive (MC4GD) does not collect, track, store, or transmit any personal data, telemetry, or browsing history to external or third-party servers. All processing and network requests occur directly from your browser.

## 2. Google Drive Access & Scope Justification
To upload your selected files, the extension requests OAuth 2.0 access to your Google Drive using the `https://www.googleapis.com/auth/drive.file` scope.
* **Scope limitation**: Access is strictly limited to files and folders created or opened by Magic Clipper itself. The extension cannot view, access, modify, or delete any other files or folders in your Google Drive.
* **Purpose**: This permission is used solely to locate or create a dedicated folder named `"Imports Magic Clipper"` and upload your selected PDFs, documents, media, or webpage captures.

## 3. Serverless Architecture
The extension connects directly to official Google Drive API v3 endpoints. There are no intermediary or proxy servers. Your files are downloaded from the source tab and uploaded to Google Drive without passing through any third party.

## 4. Local Storage
The OAuth2 access token, token expiration timestamp, the cached Google Drive folder ID, and your interface language selection are stored locally on your device via `browser.storage.local`. This data never leaves your device except to authenticate directly with Google APIs.

## 5. Open Source
This extension is fully open source under the Mozilla Public License 2.0 (MPL-2.0). The complete source code can be reviewed at:
https://github.com/mtfkarukera/mc4gd-firefox

## 6. Contact & Support
For any privacy-related questions, support, or bug reports, please contact us at **contact@mtfk.fr** or open an issue on our GitHub repository:
https://github.com/mtfkarukera/mc4gd-firefox