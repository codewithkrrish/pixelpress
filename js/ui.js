/**
 * ui.js — All DOM rendering for PixelPress.
 *
 * Why a separate UI module: app.js owns state and events, compress.js owns
 * encoding. This module is the only place that builds card/modal markup, so
 * markup changes never touch business logic. Text is set via textContent
 * wherever user-controlled data (file names) is involved to avoid HTML injection.
 */

import { formatBytes, savingsPercent } from "./compress.js";

export function createElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function savingsLabel(entry) {
  if (entry.status === "error") return { text: "—", className: "savings is-neutral" };
  if (entry.status !== "done" || !entry.outputBlob) return { text: "…", className: "savings is-neutral" };
  const pct = savingsPercent(entry.file.size, entry.outputBlob.size);
  if (Math.abs(pct) < 0.05) return { text: "Same size", className: "savings is-neutral" };
  if (pct > 0) return { text: `${pct.toFixed(1)}% smaller`, className: "savings is-positive" };
  return { text: `${Math.abs(pct).toFixed(1)}% larger`, className: "savings is-negative" };
}

/**
 * Build a card element for one entry. Event handlers are supplied by app.js
 * via callbacks so this module never needs to import state.
 */
export function buildCard(entry, { onRemove, onDownload, onCompare }) {
  const card = createElement("article", "card");
  card.dataset.id = entry.id;
  if (entry.status === "error") card.classList.add("is-error");

  // Thumbnail / compare trigger
  const thumbBtn = createElement("button", "card-thumb");
  thumbBtn.type = "button";
  thumbBtn.setAttribute("aria-label", `Compare original and compressed for ${entry.file.name}`);
  const thumbImg = document.createElement("img");
  thumbImg.alt = "";
  thumbImg.loading = "lazy";
  if (entry.thumbnailUrl) thumbImg.src = entry.thumbnailUrl;
  const hint = createElement("span", "compare-hint", "Compare");
  thumbBtn.append(thumbImg, hint);
  thumbBtn.addEventListener("click", () => onCompare(entry.id));
  card.appendChild(thumbBtn);

  const body = createElement("div", "card-body");

  const titleWrap = document.createElement("div");
  const name = createElement("div", "card-name", entry.file.name);
  name.title = entry.file.name;
  const meta = createElement("div", "card-meta");
  meta.dataset.role = "meta";
  titleWrap.append(name, meta);
  body.appendChild(titleWrap);

  const sizeRow = createElement("div", "size-row");
  const beforeBox = createElement("div", "size-box");
  beforeBox.append(createElement("span", "", "Original"), createElement("strong", "", formatBytes(entry.file.size)));
  const arrow = createElement("div", "size-arrow", "→");
  arrow.setAttribute("aria-hidden", "true");
  const afterBox = createElement("div", "size-box");
  afterBox.append(
    createElement("span", "", "Compressed"),
    createElement("strong", "", entry.outputBlob ? formatBytes(entry.outputBlob.size) : "—"),
  );
  afterBox.dataset.role = "output-size";
  const save = createElement("div", savingsLabel(entry).className, savingsLabel(entry).text);
  save.dataset.role = "savings";
  sizeRow.append(beforeBox, arrow, afterBox);
  // Savings sits below the size boxes in narrow cards via the grid's second row.
  const sizeWrap = document.createElement("div");
  sizeWrap.append(sizeRow, save);
  save.style.marginTop = "0.45rem";
  save.style.textAlign = "right";
  body.appendChild(sizeWrap);

  const status = createElement("div", "card-status");
  status.dataset.role = "status";
  body.appendChild(status);

  const actions = createElement("div", "card-actions");
  const downloadBtn = createElement("button", "btn btn-primary btn-small", "Download");
  downloadBtn.type = "button";
  downloadBtn.dataset.role = "download";
  downloadBtn.addEventListener("click", () => onDownload(entry.id));
  const removeBtn = createElement("button", "icon-btn", "×");
  removeBtn.type = "button";
  removeBtn.title = "Remove image";
  removeBtn.setAttribute("aria-label", `Remove ${entry.file.name}`);
  removeBtn.addEventListener("click", () => onRemove(entry.id));
  actions.append(downloadBtn, removeBtn);
  body.appendChild(actions);

  card.appendChild(body);
  updateCard(card, entry);
  return card;
}

export function updateCard(card, entry) {
  if (!card) return;
  card.classList.toggle("is-error", entry.status === "error");

  const meta = card.querySelector('[data-role="meta"]');
  if (meta) {
    if (entry.originalWidth && entry.originalHeight) {
      const out =
        entry.outputWidth && entry.outputHeight && entry.status === "done"
          ? ` · Output ${entry.outputWidth} × ${entry.outputHeight}`
          : "";
      meta.textContent = `${entry.originalWidth} × ${entry.originalHeight}${out}`;
    } else {
      meta.textContent = entry.status === "error" ? "Could not be processed" : "Reading image…";
    }
  }

  const outputSize = card.querySelector('[data-role="output-size"] strong');
  if (outputSize) outputSize.textContent = entry.outputBlob ? formatBytes(entry.outputBlob.size) : "—";

  const save = card.querySelector('[data-role="savings"]');
  if (save) {
    const { text, className } = savingsLabel(entry);
    save.textContent = text;
    save.className = className;
  }

  const status = card.querySelector('[data-role="status"]');
  if (status) {
    status.textContent = "";
    status.classList.toggle("is-error", entry.status === "error");
    if (entry.status === "processing") {
      const spinner = createElement("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      status.append(spinner, document.createTextNode("Compressing…"));
    } else if (entry.status === "error") {
      status.textContent = entry.errorMessage || "Something went wrong with this file.";
    } else if (entry.status === "done") {
      status.textContent = entry.outputMime ? `Ready · ${entry.outputMime.replace("image/", "").toUpperCase()}` : "Ready";
    } else {
      status.textContent = "Waiting…";
    }
  }

  const downloadBtn = card.querySelector('[data-role="download"]');
  if (downloadBtn) downloadBtn.disabled = entry.status !== "done";

  const thumbImg = card.querySelector(".card-thumb img");
  if (thumbImg && entry.thumbnailUrl && thumbImg.src !== entry.thumbnailUrl) {
    thumbImg.src = entry.thumbnailUrl;
  }
}

export function updateStats({ statsEl, entries }) {
  if (!statsEl) return;
  const done = entries.filter((e) => e.status === "done" && e.outputBlob);
  const totalOriginal = done.reduce((sum, e) => sum + e.file.size, 0);
  const totalOutput = done.reduce((sum, e) => sum + e.outputBlob.size, 0);
  const pct = totalOriginal ? savingsPercent(totalOriginal, totalOutput) : 0;

  statsEl.textContent = "";
  const mk = (label, value, cls) => {
    const span = document.createElement("span");
    span.append(document.createTextNode(`${label} `));
    const strong = createElement("strong", cls || "", value);
    span.appendChild(strong);
    return span;
  };
  statsEl.append(
    mk("Images", String(entries.length)),
    mk("Original", formatBytes(totalOriginal)),
    mk("Compressed", formatBytes(totalOutput)),
  );
  if (done.length) {
    const saved = document.createElement("span");
    saved.append(document.createTextNode("Saved "));
    const strong = createElement("strong", "saved", `${formatBytes(Math.max(0, totalOriginal - totalOutput))} (${pct.toFixed(1)}%)`);
    if (pct < 0) strong.textContent = `${Math.abs(pct).toFixed(1)}% larger overall`;
    saved.appendChild(strong);
    statsEl.appendChild(saved);
  }
}

/* ---------- Comparison modal ---------- */

export class CompareModal {
  constructor(root) {
    this.root = root;
    this.backdrop = root;
    this.imageOriginal = root.querySelector("[data-compare-original]");
    this.imageCompressed = root.querySelector("[data-compare-compressed]");
    this.afterWrap = root.querySelector("[data-compare-after]");
    this.divider = root.querySelector("[data-compare-divider]");
    this.handle = root.querySelector("[data-compare-handle]");
    this.range = root.querySelector("[data-compare-range]");
    this.title = root.querySelector("[data-modal-title]");
    this.sub = root.querySelector("[data-modal-sub]");
    this.wrap = root.querySelector("[data-compare-wrap]");
    this.entryId = null;
    this.position = 50;
    this._bind();
  }

  _bind() {
    this.range.addEventListener("input", () => this.setPosition(Number(this.range.value)));

    // Pointer dragging on the stage itself — the range input below remains
    // the keyboard-accessible control, this is the direct-manipulation layer.
    let dragging = false;
    const moveFromEvent = (event) => {
      const rect = this.wrap.getBoundingClientRect();
      const x = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
      const pct = Math.min(100, Math.max(0, (x / rect.width) * 100));
      this.setPosition(pct);
      this.range.value = String(Math.round(pct));
    };
    this.wrap.addEventListener("pointerdown", (e) => {
      dragging = true;
      this.wrap.setPointerCapture?.(e.pointerId);
      moveFromEvent(e);
    });
    this.wrap.addEventListener("pointermove", (e) => dragging && moveFromEvent(e));
    this.wrap.addEventListener("pointerup", () => (dragging = false));
    this.wrap.addEventListener("pointercancel", () => (dragging = false));

    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.backdrop.classList.contains("is-open")) this.close();
    });
    root.querySelectorAll("[data-close-modal]").forEach((btn) => btn.addEventListener("click", () => this.close()));
  }

  setPosition(pct) {
    this.position = pct;
    // Clip the compressed layer to the left portion; the original shows through on the right.
    // inset(top right bottom left) — right inset is the complement of the slider position.
    this.afterWrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    this.divider.style.left = `${pct}%`;
    this.handle.style.left = `${pct}%`;
  }

  open(entry) {
    if (!entry || !entry.originalUrl || !entry.outputUrl) return;
    this.entryId = entry.id;
    this.title.textContent = entry.file.name;
    this.sub.textContent = `${formatBytes(entry.file.size)} original · ${formatBytes(entry.outputBlob?.size ?? 0)} compressed`;
    this.imageOriginal.src = entry.originalUrl;
    this.imageCompressed.src = entry.outputUrl;
    this.setPosition(50);
    this.range.value = "50";
    this.backdrop.classList.add("is-open");
    this.backdrop.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    this.handle.focus();
  }

  close() {
    this.backdrop.classList.remove("is-open");
    this.backdrop.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    // Release large data URLs / object URLs are owned by app state, not the modal,
    // so we only clear the img src to free the decoded bitmap promptly.
    this.imageOriginal.removeAttribute("src");
    this.imageCompressed.removeAttribute("src");
  }
}

export function showToast(region, message, isSuccess = false) {
  if (!region) return;
  const toast = createElement("div", `toast${isSuccess ? " is-success" : ""}`, message);
  toast.setAttribute("role", "status");
  region.appendChild(toast);
  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    window.setTimeout(() => toast.remove(), 320);
  }, 3600);
}
