// orchestrator.js — Point d'entrée du Content Script
// VERSION 5.2 : Pipeline Readability → jsPDF (PDF) ou Markdown (texte)

console.log("[NotebookLM Clipper] ✅ Content Script V5.2 chargé (jsPDF + Markdown + Readability).");

/**
 * L'orchestrateur coordonne le pipeline de capture :
 *   1. Serializer V9 (readability-content-extractor) → container HTML autonome
 *   2a. PDF Generator V7 (jsPDF amélioré) → Base64 PDF        [format=pdf]
 *   2b. Markdown Generator V1 → texte Markdown structuré       [format=md]
 */

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "START_CAPTURE") {

    const format = message.format || "pdf";
    const intentNote = message.intentNote ?? null;

    handleCapture(format, intentNote)
      .then(result => sendResponse({
        status: "SUCCESS",
        payload: result,
        format: format
      }))
      .catch(error => {
        console.error("[Clipper V5.2] Erreur:", error);
        sendResponse({ status: "ERROR", error: error.message || String(error) });
      });

    // return true = on va répondre de manière asynchrone
    return true;
  }

  // Capturer le HTML de la sélection (demandé par le menu contextuel)
  if (message.action === "GET_SELECTION_HTML") {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const fragment = range.cloneContents();
      const wrapper = document.createElement('div');
      wrapper.appendChild(fragment);
      const serializer = new XMLSerializer();
      sendResponse({ html: serializer.serializeToString(wrapper) });
    } else {
      sendResponse({ html: null });
    }
    return;
  }
});

async function handleCapture(format, intentNote = null) {
  console.log(`[Clipper V5.2] ▶ Capture démarrée (format: ${format})...`);

  // 1. Quotas (seulement pour PDF, le Markdown est toujours léger)
  if (format === "pdf") {
    window.ClipperPDFGenerator.checkWordCountQuota();
  }

  // 2. Préparer un clone du body (utilisé en fallback par le serializer)
  const wrapperClone = document.createElement('div');
  wrapperClone.appendChild(document.body.cloneNode(true));

  // 3. Serializer : extraction + container Reader Mode + images data URIs
  console.log("[Clipper V5.2] 📖 Extraction du contenu (Readability)...");
  const container = await window.ClipperSerializer.process(wrapperClone);

  if (format === "md") {
    // 4a. Markdown Generator : texte structuré
    console.log("[Clipper V5.2] 📝 Génération Markdown...");
    const markdown = window.ClipperMarkdownGenerator.generate(container, intentNote);
    console.log(`[Clipper V5.2] ✅ Pipeline MD terminé (${markdown.length} chars)`);
    return markdown;
  } else {
    // 4b. PDF Generator : jsPDF sur le container autonome
    console.log("[Clipper V5.2] 🖨️ Génération PDF (jsPDF)...");
    const base64Pdf = await window.ClipperPDFGenerator.generate(container, intentNote);
    console.log(`[Clipper V5.2] ✅ Pipeline PDF terminé (${Math.round(base64Pdf.length / 1024)} Ko)`);
    return base64Pdf;
  }
}
