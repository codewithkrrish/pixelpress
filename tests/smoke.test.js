import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadApp, waitForDone } from "./helpers/browser.js";

test("smoke: the real page initializes with working local asset paths and an empty state", async (t) => {
  const browser = await loadApp(t);
  const { document, window } = browser;
  assert.equal(window.__pixelpress.entries.size, 0);
  assert.equal(document.querySelector("#emptyState").hidden, false);
  assert.equal(document.querySelector("#resultsToolbar").classList.contains("is-visible"), false);
  assert.equal(document.querySelector("#downloadAllBtn").disabled, true);
  assert.equal(document.querySelector("#formatSelect").value, "jpeg");
  assert.equal(document.querySelector("#qualityValue").textContent, "80%");
  assert.equal(document.querySelector("#compareModal").getAttribute("aria-hidden"), "true");
  assert.equal(browser.fetch.mock.callCount(), 0);
  for (const element of document.querySelectorAll('script[src], link[rel="stylesheet"], link[rel="icon"]')) {
    const path = element.getAttribute("src") || element.getAttribute("href");
    if (/^https?:/.test(path)) continue;
    assert.ok((await readFile(new URL(`../${path}`, import.meta.url))).length > 0, path);
  }
});

test("smoke: select image, compress, compare, download and clear without network requests", async (t) => {
  const browser = await loadApp(t);
  const { document } = browser;
  browser.selectFiles([browser.file("holiday.png")]);
  const [image] = await waitForDone(browser);
  const card = document.querySelector(".card");
  assert.equal(card.querySelector('[data-role="status"]').textContent, "Ready · JPEG");
  assert.equal(document.querySelector("#emptyState").hidden, true);
  assert.equal(document.querySelector("#fileInput").value, "");
  card.querySelector(".card-thumb").click();
  assert.equal(document.querySelector("#compareModal").getAttribute("aria-hidden"), "false");
  document.querySelector("#modalDownloadBtn").click();
  assert.deepEqual(browser.downloads, [{ url: image.outputUrl, name: "holiday-compressed.jpg" }]);
  document.querySelector("#clearAllBtn").click();
  assert.equal(browser.window.__pixelpress.entries.size, 0);
  assert.equal(document.querySelectorAll(".card").length, 0);
  assert.equal(document.querySelector("#emptyState").hidden, false);
  assert.equal(document.querySelector("#downloadAllBtn").disabled, true);
  assert.equal(document.querySelector("#compareModal").getAttribute("aria-hidden"), "true");
  assert.equal(browser.fetch.mock.callCount(), 0);
  assert.equal(browser.revokedUrls.length, 2);
  assert.equal(new Set(browser.revokedUrls).size, 2);
});

test("smoke: startup also works when the module loads before DOMContentLoaded", async (t) => {
  const browser = await loadApp(t, { loading: true });
  assert.equal(browser.window.__pixelpress, undefined);
  browser.event(browser.document, "DOMContentLoaded");
  assert.equal(browser.window.__pixelpress.entries.size, 0);
  assert.equal(browser.document.querySelector("#stats").textContent, "Images 0Original 0 BCompressed 0 B");
});
