import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCard, updateCard, updateStats, CompareModal, showToast } from "../js/ui.js";
import { createBrowser } from "./helpers/browser.js";

function entry(browser, overrides = {}) {
  return {
    id: "test-image", file: browser.file(), status: "done", outputBlob: new Blob([new Uint8Array(250)]),
    outputMime: "image/jpeg", thumbnailUrl: "blob:thumbnail", originalUrl: "blob:original", outputUrl: "blob:output",
    originalWidth: 400, originalHeight: 200, outputWidth: 200, outputHeight: 100, ...overrides,
  };
}

const noHandlers = { onRemove() {}, onDownload() {}, onCompare() {} };

test("cards render filenames as text and pass the correct ID to action callbacks", async (t) => {
  const browser = await createBrowser(t);
  const name = '<img src=x onerror="alert(1)">.png';
  const image = entry(browser, { file: browser.file(name) });
  const handlers = { onRemove: t.mock.fn(), onDownload: t.mock.fn(), onCompare: t.mock.fn() };
  const card = buildCard(image, handlers);
  assert.equal(card.dataset.id, image.id);
  assert.equal(card.querySelector(".card-name").textContent, name);
  assert.equal(card.querySelector(".card-name").children.length, 0);
  assert.equal(card.querySelector(".card-thumb").getAttribute("aria-label"), `Compare original and compressed for ${name}`);
  card.querySelector(".card-thumb").click();
  card.querySelector('[data-role="download"]').click();
  card.querySelector(".icon-btn").click();
  for (const handler of Object.values(handlers)) assert.deepEqual(handler.mock.calls[0].arguments, [image.id]);
});

test("card updates cover pending, processing, ready and error states", async (t) => {
  const browser = await createBrowser(t);
  const image = entry(browser, { status: "pending", outputBlob: null, originalWidth: null, originalHeight: null });
  const card = buildCard(image, noHandlers);
  const status = card.querySelector('[data-role="status"]');
  const download = card.querySelector('[data-role="download"]');
  assert.equal(status.textContent, "Waiting…");
  assert.equal(download.disabled, true);
  assert.equal(card.querySelector('[data-role="meta"]').textContent, "Reading image…");

  image.status = "processing";
  updateCard(card, image);
  assert.equal(status.textContent, "Compressing…");
  assert.equal(status.querySelector(".spinner").getAttribute("aria-hidden"), "true");

  Object.assign(image, entry(browser));
  updateCard(card, image);
  assert.equal(status.textContent, "Ready · JPEG");
  assert.equal(status.querySelector(".spinner"), null);
  assert.equal(download.disabled, false);
  assert.equal(card.querySelector('[data-role="meta"]').textContent, "400 × 200 · Output 200 × 100");
  assert.equal(card.querySelector('[data-role="output-size"] strong').textContent, "250 B");
  assert.equal(card.querySelector('[data-role="savings"]').textContent, "75.0% smaller");

  Object.assign(image, { status: "error", outputBlob: null, errorMessage: "Broken image" });
  updateCard(card, image);
  assert.equal(status.textContent, "Broken image");
  assert.equal(card.classList.contains("is-error"), true);
  assert.equal(download.disabled, true);
  assert.equal(card.querySelector('[data-role="savings"]').textContent, "—");
  image.status = "done";
  updateCard(card, image);
  assert.equal(card.classList.contains("is-error"), false);
  updateCard(null, image);
});

test("cards distinguish larger outputs from effectively unchanged sizes", async (t) => {
  const browser = await createBrowser(t);
  for (const [size, text, className] of [
    [1000, "Same size", "is-neutral"], [1250, "25.0% larger", "is-negative"], [500, "50.0% smaller", "is-positive"],
  ]) {
    const card = buildCard(entry(browser, { outputBlob: new Blob([new Uint8Array(size)]) }), noHandlers);
    const savings = card.querySelector('[data-role="savings"]');
    assert.equal(savings.textContent, text);
    assert.equal(savings.classList.contains(className), true);
  }
});

test("stats count every entry but calculate weighted totals from completed images only", async (t) => {
  const browser = await createBrowser(t);
  const statsEl = browser.document.querySelector("#stats");
  const entries = [
    entry(browser, { outputBlob: new Blob([new Uint8Array(100)]) }),
    entry(browser, { file: browser.file("large.png", "image/png", 9000), outputBlob: new Blob([new Uint8Array(8100)]) }),
    entry(browser, { status: "processing" }), entry(browser, { status: "error" }),
  ];
  updateStats({ statsEl, entries });
  assert.deepEqual([...statsEl.children].map((el) => el.textContent), [
    "Images 4", "Original 9.8 KB", "Compressed 8.0 KB", "Saved 1.8 KB (18.0%)",
  ]);
  updateStats({ statsEl, entries: [entry(browser, { outputBlob: new Blob([new Uint8Array(1250)]) })] });
  assert.equal(statsEl.querySelector(".saved").textContent, "25.0% larger overall");
  updateStats({ statsEl, entries: [] });
  assert.deepEqual([...statsEl.children].map((el) => el.textContent), ["Images 0", "Original 0 B", "Compressed 0 B"]);
  updateStats({ statsEl: null, entries });
});

test("comparison modal opens with metadata, resets its slider and releases images on close", async (t) => {
  const browser = await createBrowser(t);
  const root = browser.document.querySelector("#compareModal");
  const modal = new CompareModal(root);
  const image = entry(browser);
  modal.setPosition(90);
  modal.open(image);
  assert.equal(modal.entryId, image.id);
  assert.equal(modal.title.textContent, image.file.name);
  assert.equal(modal.sub.textContent, "1000 B original · 250 B compressed");
  assert.equal(root.getAttribute("aria-hidden"), "false");
  assert.equal(browser.document.body.style.overflow, "hidden");
  assert.equal(browser.document.activeElement, modal.handle);
  assert.equal(modal.range.value, "50");
  assert.equal(modal.afterWrap.style.clipPath, "inset(0 50% 0 0)");
  modal.range.value = "25";
  browser.event(modal.range, "input");
  assert.equal(modal.position, 25);
  assert.equal(modal.divider.style.left, "25%");
  assert.equal(modal.handle.style.left, "25%");
  assert.equal(modal.afterWrap.style.clipPath, "inset(0 75% 0 0)");
  modal.close();
  assert.equal(root.getAttribute("aria-hidden"), "true");
  assert.equal(browser.document.body.style.overflow, "");
  assert.equal(modal.imageOriginal.hasAttribute("src"), false);
  assert.equal(modal.imageCompressed.hasAttribute("src"), false);
});

test("comparison pointer dragging clamps to stage bounds and stops on release or cancellation", async (t) => {
  const browser = await createBrowser(t);
  const modal = new CompareModal(browser.document.querySelector("#compareModal"));
  modal.wrap.getBoundingClientRect = () => ({ left: 100, width: 200 });
  browser.event(modal.wrap, "pointermove", { clientX: 150 });
  assert.equal(modal.position, 50);
  browser.event(modal.wrap, "pointerdown", { clientX: 0, pointerId: 1 });
  assert.equal(modal.position, 0);
  browser.event(modal.wrap, "pointermove", { clientX: 400 });
  assert.equal(modal.position, 100);
  assert.equal(modal.range.value, "100");
  browser.event(modal.wrap, "pointerup");
  browser.event(modal.wrap, "pointermove", { clientX: 150 });
  assert.equal(modal.position, 100);
  browser.event(modal.wrap, "pointerdown", { clientX: 150, pointerId: 1 });
  browser.event(modal.wrap, "pointercancel");
  browser.event(modal.wrap, "pointermove", { clientX: 300 });
  assert.equal(modal.position, 25);
});

test("comparison closes using Escape, backdrop or either close button, but not content clicks", async (t) => {
  const browser = await createBrowser(t);
  const root = browser.document.querySelector("#compareModal");
  const modal = new CompareModal(root);
  modal.open(null);
  modal.open(entry(browser, { outputUrl: null }));
  assert.equal(root.classList.contains("is-open"), false);
  for (const close of [
    () => browser.event(browser.document, "keydown", { key: "Escape" }),
    () => root.click(),
    ...[...root.querySelectorAll("[data-close-modal]")].map((button) => () => button.click()),
  ]) {
    modal.open(entry(browser));
    root.querySelector(".modal").click();
    assert.equal(root.classList.contains("is-open"), true);
    close();
    assert.equal(root.classList.contains("is-open"), false);
  }
});

test("toasts expose a status message and disappear after the fade-out timer", async (t) => {
  const browser = await createBrowser(t);
  const region = browser.document.querySelector("#toastRegion");
  showToast(region, "<b>Downloaded</b>", true);
  const toast = region.firstElementChild;
  assert.equal(toast.getAttribute("role"), "status");
  assert.equal(toast.classList.contains("is-success"), true);
  assert.equal(toast.textContent, "<b>Downloaded</b>");
  assert.equal(toast.children.length, 0);
  browser.runTimers(3600);
  assert.equal(toast.style.opacity, "0");
  assert.equal(toast.isConnected, true);
  browser.runTimers(320);
  assert.equal(region.children.length, 0);
  showToast(null, "No region");
});
