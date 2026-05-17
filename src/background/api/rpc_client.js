// rpc_client.js : Emulateur RPC pour NotebookLM Personal
// Traduit fidèlement la logique de notebooklm-py (encoder.py + decoder.py)

/**
 * Moteur RPC pour construire et envoyer les requêtes formatées "batchexecute"
 * Utilisé lorsqu'aucune API officielle n'est disponible (Comptes personnels).
 */

/** Levée quand la structure d'une réponse RPC ne correspond plus
 *  au schéma connu — signe probable d'un changement d'API Google. */
export class RpcApiChangedError extends Error {
    constructor(rpcId) {
        super(`L'API NotebookLM a été modifiée (RPC: ${rpcId}). Mise à jour requise.`);
        this.name  = "RpcApiChangedError";
        this.rpcId = rpcId;
    }
}

/** Levée pour toute autre erreur RPC (réponse vide, HTTP 4xx, etc.). */
export class RpcError extends Error {
    constructor(rpcId, code, detail) {
        super(`Erreur RPC ${rpcId} [${code}] : ${detail}`);
        this.name  = "RpcError";
        this.rpcId = rpcId;
        this.code  = code;
    }
}

// ============================================
// 1. ENCODEUR (encoder.py)
// ============================================

function encodeRpcRequest(rpcId, params) {
    // JSON-encode params sans espaces (format compact comme Chrome)
    const paramsJson = JSON.stringify(params);
    // Build inner request: [rpc_id, json_params, null, "generic"]
    const inner = [rpcId, paramsJson, null, "generic"];
    // Triple-nest the request  
    return [[inner]];
}

function buildRequestBody(rpcRequest, csrfToken) {
    // JSON-encode the request (compact)
    const fReq = JSON.stringify(rpcRequest);
    // Construire le body encodé en URL  
    const parts = [`f.req=${encodeURIComponent(fReq)}`];
    if (csrfToken) {
        parts.push(`at=${encodeURIComponent(csrfToken)}`);
    }
    // Trailing & comme dans notebooklm-py
    return parts.join('&') + '&';
}

function buildQueryParams(rpcId) {
    return new URLSearchParams({
        'rpcids': rpcId,
        'source-path': '/',
        'hl': 'en',
        'rt': 'c'   // Chunked response mode
    }).toString();
}

// ============================================
// 2. DECODEUR (decoder.py) 
// ============================================

/**
 * Supprime le préfixe anti-XSSI )]}'
 */
function stripAntiXssi(response) {
    return response.replace(/^\)]\}'[\r\n]+/, '');
}

/**
 * Parse le format de réponse chunké (mode rt=c).
 * Format: lignes alternées de byte_count (entier) + json_payload.
 * C'est la traduction exacte de parse_chunked_response() de decoder.py
 */
function parseChunkedResponse(response) {
    if (!response || !response.trim()) return [];
    
    const chunks = [];
    const lines = response.trim().split('\n');
    let i = 0;
    
    while (i < lines.length) {
        const line = lines[i].trim();
        
        // Skip lignes vides
        if (!line) { i++; continue; }
        
        // Essayer de parser comme un byte count (entier)
        if (/^\d+$/.test(line)) {
            i++; // Avancer à la ligne suivante (le payload JSON)
            if (i < lines.length) {
                try {
                    const chunk = JSON.parse(lines[i]);
                    chunks.push(chunk);
                } catch (e) {
                    // Chunk malformé, on skip
                }
            }
            i++;
        } else {
            // Pas un byte count, essayer de parser comme JSON directement
            try {
                const chunk = JSON.parse(line);
                chunks.push(chunk);
            } catch (e) {
                // Skip les lignes non-JSON
            }
            i++;
        }
    }
    return chunks;
}

/**
 * Extrait le résultat d'un RPC ID spécifique depuis les chunks.
 * Traduction de extract_rpc_result() de decoder.py
 */
function extractRpcResult(chunks, rpcId) {
    for (const chunk of chunks) {
        if (!Array.isArray(chunk)) continue;
        
        // Le chunk peut être [[item1, item2, ...]] ou [item]
        const items = (chunk.length > 0 && Array.isArray(chunk[0])) ? chunk : [chunk];
        
        for (const item of items) {
            if (!Array.isArray(item) || item.length < 3) continue;
            
            // Réponse d'erreur
            if (item[0] === "er" && item[1] === rpcId) {
                throw new Error(`RPC Error pour ${rpcId}: code ${item[2]}`);
            }
            
            // Réponse de succès : ["wrb.fr", "rpcId", "json_stringifié_du_résultat", ...]
            if (item[0] === "wrb.fr" && item[1] === rpcId) {
                const resultData = item[2];
                if (typeof resultData === 'string') {
                    try {
                        return JSON.parse(resultData);
                    } catch (e) {
                        return resultData;
                    }
                }
                return resultData;
            }
        }
    }
    return null;
}

/**
 * Pipeline complet de décodage : strip prefix -> parse chunks -> extract result
 * Traduction de decode_response() de decoder.py
 */
function decodeResponse(rawResponse, rpcId) {
    const cleaned = stripAntiXssi(rawResponse);
    const chunks = parseChunkedResponse(cleaned);
    return extractRpcResult(chunks, rpcId);
}

/**
 * Valide et extrait le payload utile d'une réponse batchexecute.
 * Incorpore un filet de sécurité structurel.
 * @param {string} rawResponse  — réponse brute HTTP
 * @param {string} rpcId        — ex: "izAoDd", "o4cbdc", "wXbhsf"
 * @returns {any}               — payload parsé, prêt à consommer
 * @throws {RpcApiChangedError | RpcError | Error}
 */
export function validateAndExtractRpcResponse(rawResponse, rpcId) {
    // Étape 1 — La réponse est-elle valide à la source ?
    if (!rawResponse || typeof rawResponse !== "string") {
        throw new RpcError(rpcId, "EMPTY_RESPONSE", "La réponse batchexecute est vide ou de type inattendu.");
    }

    // Étape 2 — Décoder via le pipeline standardisé existant
    const chunks = parseChunkedResponse(stripAntiXssi(rawResponse));
    const result = extractRpcResult(chunks, rpcId);

    // Étape 3 — La structure contient-elle des données exploitables ?
    if (result === null || result === undefined) {
        // Aperçu brut sans sanitisation locale (sanitisation dans background.js uniquement)
        const preview = rawResponse.slice(0, 500);
        console.warn(`[NotebookLM] Réponse RPC ${rpcId} — structure inattendue. Aperçu brut :`, preview);
        throw new RpcApiChangedError(rpcId);
    }

    return result;
}

// ============================================
// 3. TRANSPORT (envoi HTTP)
// ============================================

export async function sendBatchExecute(rpcId, jsonArgs, authuserIndex = 0) {
    const data = await browser.storage.local.get(['nblm_personal_cookie', 'nblm_csrf']);
    if (!data.nblm_personal_cookie || !data.nblm_csrf) {
        throw new Error("Authentification personnelle non finalisée.");
    }

    // Encoder la requête RPC
    const rpcRequest = encodeRpcRequest(rpcId, jsonArgs);
    const body = buildRequestBody(rpcRequest, data.nblm_csrf);
    const queryString = buildQueryParams(rpcId);
    const endpoint = `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?${queryString}&authuser=${authuserIndex}`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            'Cookie': data.nblm_personal_cookie
        },
        body: body
    });

    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            await browser.storage.local.remove(['nblm_personal_cookie', 'nblm_csrf']);
            throw new Error("Jeton RPC rejeté (401/403). Veuillez rafraîchir votre session NotebookLM.");
        }
        throw new Error(`Erreur réseau batchexecute: ${response.status}`);
    }

    const responseText = await response.text();
    
    // Valider la structure et extraire avec le pipeline standardisé
    return validateAndExtractRpcResponse(responseText, rpcId);
}

// ============================================
// 4. FACADES MÉTIER
// ============================================

export async function listPersonalNotebooks(authuserIndex = 0) {
    const rpcId = "wXbhsf";
    
    // Paramètres exacts de notebooklm-py : [None, 1, None, [2]]
    const result = await sendBatchExecute(rpcId, [null, 1, null, [2]], authuserIndex);
    
    if (!result || !Array.isArray(result)) {
        console.warn("[NotebookLM RPC] Réponse inattendue pour LIST_NOTEBOOKS:", result);
        return [];
    }
    
    // Structure de la réponse (from types.py Notebook.from_api_response) :
    // result = [ [notebook1, notebook2, ...], ... ]
    // Chaque notebook est un array où :
    //   - index 0 = titre (string)
    //   - index 2 = id (string)
    const rawNotebooks = Array.isArray(result[0]) && Array.isArray(result[0][0]) 
        ? result[0]    // [[nb1], [nb2], ...] 
        : result;      // [nb1, nb2, ...]
    
    const notebooks = [];
    for (const nb of rawNotebooks) {
        if (!Array.isArray(nb)) continue;
        
        const title = (nb.length > 0 && typeof nb[0] === 'string') ? nb[0].replace('thought\n', '').trim() : '';
        const id = (nb.length > 2 && typeof nb[2] === 'string') ? nb[2] : '';
        
        if (id && title) {
            notebooks.push({ id, title });
        }
    }
    
    if (notebooks.length === 0) {
       console.warn("[NotebookLM RPC] Parsing échoué. Structure brute:", JSON.stringify(result).substring(0, 2000));
    }
    
    return notebooks;
}

export async function createPersonalNotebook(title, authuserIndex = 0) {
    // RPC ID: CCqFvf (de notebooklm-py)
    const rpcId = "CCqFvf";
    const result = await sendBatchExecute(rpcId, [title, null], authuserIndex);
    
    // L'ID du nouveau carnet est typiquement à result[2] ou result[0][2]
    if (result && Array.isArray(result)) {
        const nbId = (typeof result[2] === 'string') ? result[2] : 
                     (Array.isArray(result[0]) && typeof result[0][2] === 'string') ? result[0][2] : null;
        if (nbId) return nbId;
    }
    
    throw new Error("Impossible d'extraire l'ID du carnet créé.");
}

/**
 * Ajoute une source texte (Markdown) directement dans un carnet NotebookLM.
 * Utilise le RPC izAoDd (ADD_SOURCE — Text) de notebooklm-py.
 * Pas besoin de protocole resumable : injection directe en une seule requête.
 *
 * @param {string} notebookId - ID du carnet cible.
 * @param {string} title - Titre de la source (affiché dans NotebookLM).
 * @param {string} content - Contenu textuel/Markdown à injecter.
 */
export async function addTextSource(notebookId, title, content, authuserIndex = 0) {
    
    const rpcId = "izAoDd";
    // Structure exacte de notebooklm-py : _sources.py::add_text()
    // [title, content] à la position [1] dans un tableau de 8 éléments
    const params = [
        [[null, [title, content], null, null, null, null, null, null]],
        notebookId,
        [2],
        null,
        null,
    ];
    
    const result = await sendBatchExecute(rpcId, params, authuserIndex);
    
    if (result) {
        console.log("[NotebookLM RPC] \u2705 Source texte ajoutée.");
    }
    
    return true;
}

/**
 * Ajoute une source URL directement dans un carnet NotebookLM.
 * NotebookLM scrape et indexe la page lui-même.
 * Utilise le RPC izAoDd (ADD_SOURCE — URL) de notebooklm-py.
 *
 * @param {string} notebookId - ID du carnet cible.
 * @param {string} url - URL complète de la page web à importer.
 */
export async function addUrlSource(notebookId, url, authuserIndex = 0) {
    
    const rpcId = "izAoDd";
    // Structure exacte de notebooklm-py : _sources.py::_add_url_source()
    // L'URL va à la position [2] dans un tableau de 8 éléments
    const params = [
        [[null, null, [url], null, null, null, null, null]],
        notebookId,
        [2],
        null,
        null,
    ];
    
    const result = await sendBatchExecute(rpcId, params, authuserIndex);
    
    if (result) {
        console.log("[NotebookLM RPC] \u2705 Source URL ajoutée.");
    }
    
    return true;
}

/**
 * Ajoute une source Google Drive (Docs, Sheets, Slides) directement dans NotebookLM.
 * Utilise l'ID du fichier pur pour que NotebookLM crée un lien synchronisable natif.
 * Utilise le RPC izAoDd avec le payload typique pour Drive (Slot 0).
 *
 * @param {string} notebookId - ID du carnet cible.
 * @param {string} fileId - ID du fichier Google Drive extrait de l'URL.
 * @param {string} mimeType - Type MIME (ex: application/vnd.google-apps.document).
 * @param {string} title - Titre du document.
 */
export async function addDriveSource(notebookId, fileId, mimeType, title, authuserIndex = 0) {
    const rpcId = "izAoDd";
    
    // Structure exacte de notebooklm-py : _sources.py::_add_drive_source()
    // Le bloc Drive est un tableau de 11 éléments (PAS enveloppé dans un wrapper 8-slots
    // comme Text/URL — c'est la différence clé).
    // [0] = [fileId, mimeType, 1, title]
    // [1-9] = null
    // [10] = 1
    const driveBlock = [
        [fileId, mimeType, 1, title],
        null, null, null, null, null, null, null, null, null, 1
    ];

    const params = [
        [driveBlock],
        notebookId,
        [2],
        [1, null, null, null, null, null, null, null, null, null, [1]]
    ];
    
    const result = await sendBatchExecute(rpcId, params, authuserIndex);
    
    if (result) {
        console.log("[NotebookLM RPC] ✅ Source Google Drive ajoutée.");
    }
    
    return true;
}

/**
 * Ajoute une source YouTube dans un carnet NotebookLM.
 * Contrairement à addUrlSource (URL générique), ce payload spécialisé
 * déclenche le pipeline YouTube natif de Google : extraction du transcript,
 * icône YouTube, lecteur vidéo intégré.
 *
 * Source : notebooklm-py _sources.py::_add_youtube_source()
 * L'URL va à la position [7] dans un tableau de 11 éléments (vs [2] sur 8 pour URL).
 *
 * @param {string} notebookId - ID du carnet cible.
 * @param {string} url - URL YouTube complète (youtube.com/watch?v=... ou youtu.be/...).
 */
export async function addYouTubeSource(notebookId, url, authuserIndex = 0) {
    
    const rpcId = "izAoDd";
    // Structure exacte de notebooklm-py : _sources.py::_add_youtube_source()
    // L'URL va à la position [7] dans un tableau de 11 éléments
    const params = [
        [[null, null, null, null, null, null, null, [url], null, null, 1]],
        notebookId,
        [2],
        [1, null, null, null, null, null, null, null, null, null, [1]],
    ];
    
    const result = await sendBatchExecute(rpcId, params, authuserIndex);
    
    if (result) {
        console.log("[NotebookLM RPC] \u2705 Source YouTube ajoutée.");
    }
    
    return true;
}

export async function uploadPersonalSource(notebookId, pdfDataUri, customTitle = null, authuserIndex = 0) {
    
    const data = await browser.storage.local.get(['nblm_personal_cookie', 'nblm_csrf']);
    if (!data.nblm_personal_cookie || !data.nblm_csrf) {
        throw new Error("Authentification personnelle non finalisée.");
    }

    // Convertir le data URI en binaire
    const base64Content = pdfDataUri.split(',')[1]; // Retirer le préfixe "data:application/pdf;base64,"
    const binaryString = atob(base64Content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const pdfBlob = new Blob([bytes], { type: 'application/pdf' });
    
    // Nom du fichier = titre de la page (ou fallback générique)
    const filename = customTitle 
        ? `${customTitle}.pdf` 
        : `Capture_${new Date().toISOString().slice(0,10)}.pdf`;
    const fileSize = pdfBlob.size;

    // ╔════════════════════════════════════════════════════════╗
    // ║ ÉTAPE 1 : Enregistrer l'intention de source (RPC)     ║
    // ║ RPC ID: o4cbdc (ADD_SOURCE_FILE)                      ║
    // ║ Params: [[[filename]], notebook_id, [2], [1,...,[1]]]  ║
    // ╚════════════════════════════════════════════════════════╝
    const registerRpcId = "o4cbdc";
    const registerParams = [
        [[filename]],
        notebookId,
        [2],
        [1, null, null, null, null, null, null, null, null, null, [1]]
    ];
    
    const registerResult = await sendBatchExecute(registerRpcId, registerParams, authuserIndex);
    
    // Extraire le SOURCE_ID de la réponse (structure imbriquée: [[[[id]]]] ou similaire)
    const sourceId = extractFirstString(registerResult);
    if (!sourceId) {
        throw new Error("\u00c9chec enregistrement source: impossible d'obtenir SOURCE_ID.");
    }

    // ╔════════════════════════════════════════════════════════╗
    // ║ ÉTAPE 2 : Démarrer le upload resumable                ║
    // ║ POST https://notebooklm.google.com/upload/_/          ║
    // ║ Headers: x-goog-upload-command: start                 ║
    // ╚════════════════════════════════════════════════════════╝
    const uploadStartUrl = `https://notebooklm.google.com/upload/_/?authuser=${authuserIndex}`;
    
    const startBody = JSON.stringify({
        "PROJECT_ID": notebookId,
        "SOURCE_NAME": filename,
        "SOURCE_ID": sourceId
    });
    
    const startResponse = await fetch(uploadStartUrl, {
        method: 'POST',
        headers: {
            'Accept': '*/*',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Cookie': data.nblm_personal_cookie,
            'Origin': 'https://notebooklm.google.com',
            'Referer': 'https://notebooklm.google.com/',
            'x-goog-authuser': String(authuserIndex),
            'x-goog-upload-command': 'start',
            'x-goog-upload-header-content-length': String(fileSize),
            'x-goog-upload-protocol': 'resumable'
        },
        body: startBody
    });
    
    if (!startResponse.ok) {
        throw new Error(`Échec démarrage upload: HTTP ${startResponse.status}`);
    }
    
    const uploadUrl = startResponse.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
        throw new Error("\u00c9chec: pas de x-goog-upload-url dans la r\u00e9ponse du serveur.");
    }

    // ╔════════════════════════════════════════════════════════╗
    // ║ ÉTAPE 3 : Upload du fichier + finalize                ║
    // ║ POST vers l'upload URL obtenue à l'étape 2            ║
    // ║ Headers: x-goog-upload-command: upload, finalize      ║
    // ╚════════════════════════════════════════════════════════╝
    const finalizeResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Accept': '*/*',
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            'Cookie': data.nblm_personal_cookie,
            'Origin': 'https://notebooklm.google.com',
            'Referer': 'https://notebooklm.google.com/',
            'x-goog-authuser': String(authuserIndex),
            'x-goog-upload-command': 'upload, finalize',
            'x-goog-upload-offset': '0'
        },
        body: pdfBlob
    });
    
    if (!finalizeResponse.ok) {
        throw new Error(`Échec upload fichier: HTTP ${finalizeResponse.status}`);
    }
    
    console.log(`[NotebookLM RPC] \u2705 Upload termin\u00e9 (${Math.round(fileSize / 1024)} Ko).`);
    return true;
}

/**
 * Utilitaire : extraire la première string d'une structure imbriquée
 * (Pour parser le SOURCE_ID depuis [[[[id]]]] ou [[[id]]] etc.)
 */
function extractFirstString(data) {
    if (typeof data === 'string') return data;
    if (Array.isArray(data) && data.length > 0) {
        return extractFirstString(data[0]);
    }
    return null;
}

