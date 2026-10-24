/**
 * app.js — PixelPress application wiring and state.
 *
 * State model: a Map<id, Entry> is the single source of truth.
 * Entry = {
 *   id, file,
 *   thumbnailUrl, originalUrl, outputUrl,  // object URLs owned by the entry
 *   outputBlob, outputMime, outputName,
 *   originalWidth, originalHeight, outputWidth, outputHeight,
 *   status: "pending" | "processing" | "done" | "error",
 *   errorMessage
 * }
 * Object URLs are revoked exactly once, when the entry is removed or replaced —
 * this is the main memory-leak guard for a batch tool that can hold many images.
 */

import {
  compressImage,
  decodeImage,
  formatBytes,
  isSupportedFile,
  buildOutputName,
} from "./compress.js";
import { buildCard, updateCard, updateStats, CompareModal, showToast } from "./ui.js";

const $ = (selector) => document.querySelector(selector);

const els = {
  dropzone: $("#dropzone"),
  fileInput: $("#fileInput"),
  format: $("#formatSelect"),
  quality: $("#qualityRange"),
  qualityValue: $("#qualityValue"),
  qualityHint: $("#qualityHint"),
  maxWidth: $("#maxWidthInput"),
  grid: $("#resultsGrid"),
  emptyState: $("#emptyState"),
  toolbar: $("#resultsToolbar"),
  stats: $("#stats"),
  downloadAllBtn: $("#downloadAllBtn"),
  clearAllBtn: $("#clearAllBtn"),
  modalRoot: $("#compareModal"),
  modalDownloadBtn: $("#modalDownloadBtn"),
  toastRegion: $("#toastRegion"),
};

const ACCEPTED_LABEL = "JPG, PNG, WebP, GIF or BMP";

/** @type {Map<string, object>} */
const entries = new Map();
let modal = null;
let recompressTimer = null;
let runToken = 0; // Incremented per batch run; stale async results check it before writing state.

function createId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getSettings() {
  const rawMax = els.maxWidth.value.trim();
  const parsedMax = rawMax === "" ? null : Number.parseInt(rawMax, 10);
  return {
    format: els.format.value,
    quality: Number(els.quality.value),
    // Invalid or non-positive widths are treated as "no resize" rather than erroring the batch.
    maxWidth: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null,
  };
}

function syncQualityControl() {
  const isPng = els.format.value === "png";
  els.quality.disabled = isPng;
  els.qualityValue.textContent = `${els.quality.value}%`;
  if (isPng) {
    els.qualityHint.textContent = "PNG is lossless, so the quality slider does not apply. Use JPEG or WebP for smaller files.";
    els.qualityHint.classList.add("is-warning");
  } else if (els.format.value === "keep") {
    els.qualityHint.textContent = "Quality applies to JPEG and WebP outputs. PNG files kept as PNG stay lossless.";
    els.qualityHint.classList.remove("is-warning");
  } else {
    els.qualityHint.textContent = "Lower quality means a smaller file. 75–85 is a good balance for photos.";
    els.qualityHint.classList.remove("is-warning");
  }
}

function refreshChrome() {
  const hasEntries = entries.size > 0;
  els.emptyState.hidden = hasEntries;
  els.toolbar.classList.toggle("is-visible", hasEntries);
  const doneCount = [...entries.values()].filter((e) => e.status === "done").length;
  els.downloadAllBtn.disabled = doneCount === 0;
  els.downloadAllBtn.textContent = doneCount > 1 ? `Download all (${doneCount})` : "Download all";
  updateStats({ statsEl: els.stats, entries: [...entries.values()] });
}

function revokeEntryUrls(entry) {
  // thumbnailUrl and originalUrl intentionally share one URL (see addFiles),
  // so revoke each distinct URL exactly once, then null the fields so a stale
  // reference (e.g. the modal after removal) cannot resurrect a dead URL.
  const urls = new Set([entry.thumbnailUrl, entry.originalUrl, entry.outputUrl].filter(Boolean));
  for (const url of urls) URL.revokeObjectURL(url);
  entry.thumbnailUrl = null;
  entry.originalUrl = null;
  entry.outputUrl = null;
}

function cardFor(entry) {
  return els.grid.querySelector(`[data-id="${CSS.escape(entry.id)}"]`);
}

async function processEntry(entry, settings, token) {
  entry.status = "processing";
  entry.errorMessage = null;
  updateCard(cardFor(entry), entry);
  refreshChrome();

  try {
    const result = await compressImage(entry.file, settings);
    // A newer settings change or a removal superseded this run — discard quietly.
    if (token !== runToken || !entries.has(entry.id)) return;

    if (entry.outputUrl) URL.revokeObjectURL(entry.outputUrl);
    entry.outputBlob = result.blob;
    entry.outputMime = result.outputMime;
    entry.outputName = buildOutputName(entry.file.name, result.outputMime);
    entry.outputUrl = URL.createObjectURL(result.blob);
    entry.outputWidth = result.width;
    entry.outputHeight = result.height;
    entry.originalWidth = result.originalWidth;
    entry.originalHeight = result.originalHeight;
    entry.status = "done";
  } catch (err) {
    if (token !== runToken || !entries.has(entry.id)) return;
    entry.status = "error";
    entry.outputBlob = null;
    entry.errorMessage =
      err instanceof Error ? err.message : "This file could not be compressed. It may be corrupt or unsupported.";
  }

  updateCard(cardFor(entry), entry);
  refreshChrome();
}

async function processAll() {
  const settings = getSettings();
  const token = ++runToken;
  // Errored entries are retried on a settings change too — a format switch can
  // succeed where an earlier encode failed. Truly undecodable files error again.
  const targets = [...entries.values()];
  await Promise.allSettled(targets.map((entry) => processEntry(entry, settings, token)));
}

function scheduleReprocess() {
  window.clearTimeout(recompressTimer);
  // Debounce: dragging the quality slider fires dozens of events; compressing
  // on every tick would thrash the CPU and produce flickering results.
  recompressTimer = window.setTimeout(() => {
    if (entries.size) processAll();
  }, 280);
}

/**
 * Extract File objects from a drop/paste DataTransfer. `files` is the fast
 * path; some browsers (and drags sourced from other apps) expose dragged
 * files only through `items`, so fall back to getAsFile() there.
 */
function filesFromDataTransfer(dt) {
  if (!dt) return [];
  if (dt.files?.length) return [...dt.files];
  return [...(dt.items || [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  let added = 0;
  let skipped = 0;

  for (const file of files) {
    if (!isSupportedFile(file)) {
      skipped += 1;
      // Still surface unsupported files as an error card so the user understands
      // exactly which file was rejected instead of it silently vanishing.
      const entry = {
        id: createId(),
        file,
        thumbnailUrl: null,
        originalUrl: null,
        outputUrl: null,
        outputBlob: null,
        outputMime: null,
        outputName: null,
        originalWidth: null,
        originalHeight: null,
        outputWidth: null,
        outputHeight: null,
        status: "error",
        errorMessage: `Unsupported file type. PixelPress accepts ${ACCEPTED_LABEL}.`,
      };
      entries.set(entry.id, entry);
      els.grid.appendChild(buildCard(entry, handlers));
      continue;
    }

    const entry = {
      id: createId(),
      file,
      thumbnailUrl: null,
      originalUrl: null,
      outputUrl: null,
      outputBlob: null,
      outputMime: null,
      outputName: null,
      originalWidth: null,
      originalHeight: null,
      outputWidth: null,
      outputHeight: null,
      status: "pending",
      errorMessage: null,
    };
    entries.set(entry.id, entry);

    // One object URL serves both the thumbnail <img> and the modal's "original"
    // view — duplicating it would double the retained references for large files.
    entry.originalUrl = URL.createObjectURL(file);
    entry.thumbnailUrl = entry.originalUrl;

    // Probe dimensions early so the card shows useful info even before compression finishes.
    try {
      const decoded = await decodeImage(file);
      entry.originalWidth = decoded.width;
      entry.originalHeight = decoded.height;
      decoded.cleanup();
    } catch {
      entry.status = "error";
      entry.errorMessage = "Could not read this image. The file may be corrupt or in an unsupported variant.";
    }

    els.grid.appendChild(buildCard(entry, handlers));
    added += 1;
  }

  refreshChrome();

  if (skipped) {
    showToast(els.toastRegion, `${skipped} file${skipped > 1 ? "s were" : " was"} skipped — unsupported type.`);
  }
  if (added) {
    processAll();
  }
}

function removeEntry(id) {
  const entry = entries.get(id);
  if (!entry) return;
  if (modal && modal.entryId === id) modal.close();
  revokeEntryUrls(entry);
  entries.delete(id);
  cardFor(entry)?.remove();
  runToken += 1; // Invalidate any in-flight result for the removed entry.
  refreshChrome();
}

function clearAll() {
  if (modal) modal.close();
  for (const entry of entries.values()) revokeEntryUrls(entry);
  entries.clear();
  els.grid.textContent = "";
  runToken += 1;
  refreshChrome();
}

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadEntry(id) {
  const entry = entries.get(id);
  if (!entry || entry.status !== "done" || !entry.outputUrl) return;
  triggerDownload(entry.outputUrl, entry.outputName || "compressed.jpg");
}

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  // The CDN script tag in index.html is the primary path. This dynamic fallback
  // covers the case where that tag was blocked but a retry can still succeed.
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return window.JSZip || null;
}

async function downloadAll() {
  const done = [...entries.values()].filter((e) => e.status === "done" && e.outputBlob);
  if (!done.length) return;
  if (done.length === 1) {
    downloadEntry(done[0].id);
    return;
  }

  els.downloadAllBtn.disabled = true;
  const originalLabel = els.downloadAllBtn.textContent;
  els.downloadAllBtn.textContent = "Preparing ZIP…";

  try {
    const JSZipCtor = await loadJSZip();
    if (!JSZipCtor) throw new Error("JSZip unavailable");

    const zip = new JSZipCtor();
    const usedNames = new Set();
    for (const entry of done) {
      // Two different source files can map to the same output name
      // (e.g. photo.png and photo.jpg both -> photo-compressed.jpg).
      let name = entry.outputName;
      let counter = 2;
      while (usedNames.has(name)) {
        name = entry.outputName.replace(/(\.[^.]+)$/, `-${counter++}$1`);
      }
      usedNames.add(name);
      zip.file(name, entry.outputBlob);
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    // STORE (no extra compression): images are already compressed, so DEFLATE
    // would burn CPU for near-zero size benefit.
    const url = URL.createObjectURL(blob);
    triggerDownload(url, "pixelpress-images.zip");
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(els.toastRegion, `${done.length} images downloaded as a ZIP.`, true);
  } catch {
    // Plain fallback: sequential individual downloads. Browsers may throttle
    // rapid multi-downloads, so a small stagger gives each prompt time to register.
    showToast(els.toastRegion, "ZIP was unavailable, so the files will download one by one.");
    done.forEach((entry, index) => {
      window.setTimeout(() => downloadEntry(entry.id), index * 350);
    });
  } finally {
    els.downloadAllBtn.textContent = originalLabel;
    refreshChrome();
  }
}

const handlers = {
  onRemove: removeEntry,
  onDownload: downloadEntry,
  onCompare: (id) => {
    const entry = entries.get(id);
    if (entry && entry.status === "done") modal.open(entry);
    else if (entry && entry.status === "error") {
      showToast(els.toastRegion, "This image could not be processed, so there is nothing to compare yet.");
    } else {
      showToast(els.toastRegion, "Still compressing — try again in a moment.");
    }
  },
};

/* ---------- Wiring ---------- */

function init() {
  modal = new CompareModal(els.modalRoot);
  els.modalDownloadBtn.addEventListener("click", () => {
    if (modal.entryId) downloadEntry(modal.entryId);
  });

  // Dropzone: click, keyboard (Enter/Space on the focusable zone), and drag events.
  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", () => {
    addFiles(els.fileInput.files);
    // Reset so selecting the same file again after removal still fires "change".
    els.fileInput.value = "";
  });

  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const evt of ["dragenter", "dragover"]) {
    els.dropzone.addEventListener(evt, (e) => {
      stop(e);
      // Without dropEffect, some browsers show a "not allowed" cursor over the
      // zone even though the drop itself would be accepted.
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      els.dropzone.classList.add("is-dragover");
    });
  }
  els.dropzone.addEventListener("dragleave", (e) => {
    stop(e);
    // Moving across the zone's children (icon, heading, text) fires dragleave
    // on the zone itself. Only clear the highlight when the drag has genuinely
    // left the zone — relatedTarget says where it went.
    if (e.relatedTarget && els.dropzone.contains(e.relatedTarget)) return;
    els.dropzone.classList.remove("is-dragover");
  });
  els.dropzone.addEventListener("drop", (e) => {
    stop(e);
    els.dropzone.classList.remove("is-dragover");
    document.body.classList.remove("is-dragging");
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) addFiles(files);
  });

  // Dragging anywhere over the window should not navigate away from the page,
  // and a drop anywhere on the page is accepted — users aim at the page, not
  // always precisely at the zone. (Drops on the zone itself never reach this
  // handler: the zone's own drop listener stops propagation.)
  window.addEventListener("dragenter", () => document.body.classList.add("is-dragging"));
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("is-dragging");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("is-dragging");
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) addFiles(files);
  });
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });

  els.format.addEventListener("change", () => {
    syncQualityControl();
    scheduleReprocess();
  });
  els.quality.addEventListener("input", () => {
    els.qualityValue.textContent = `${els.quality.value}%`;
    scheduleReprocess();
  });
  els.maxWidth.addEventListener("input", scheduleReprocess);
  els.maxWidth.addEventListener("change", scheduleReprocess);

  els.downloadAllBtn.addEventListener("click", downloadAll);
  els.clearAllBtn.addEventListener("click", clearAll);

  syncQualityControl();
  refreshChrome();

  // Expose a tiny handle for debugging in devtools; harmless in production.
  window.__pixelpress = { entries, formatBytes };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
