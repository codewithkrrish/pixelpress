import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
let appImport = 0;

// Use the real page markup without fetching CDN scripts, fonts or images.
// Only browser-only image/Canvas APIs are mocked; app, UI and compression
// modules run unchanged. This is a DOM harness, not a real-browser encoder.
export async function createBrowser(t) {
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  await new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));

  const originals = new Map();
  const install = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  t.after(() => {
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  const createdUrls = [];
  const revokedUrls = [];
  window.URL.createObjectURL = t.mock.fn((value) => {
    const url = `blob:pixelpress-test-${createdUrls.length + 1}`;
    createdUrls.push({ url, value });
    return url;
  });
  window.URL.revokeObjectURL = t.mock.fn((url) => revokedUrls.push(url));

  const bitmaps = [];
  const decode = t.mock.fn(async () => {
    const bitmap = { width: 400, height: 200, close: t.mock.fn() };
    bitmaps.push(bitmap);
    return bitmap;
  });
  const canvases = [];
  const getContext = t.mock.method(window.HTMLCanvasElement.prototype, "getContext", function () {
    const context = { fillRect: t.mock.fn(), drawImage: t.mock.fn() };
    canvases.push({ canvas: this, context });
    return context;
  });
  const encode = t.mock.method(window.HTMLCanvasElement.prototype, "toBlob", function (callback, mime) {
    callback(new Blob([new Uint8Array(100)], { type: mime }));
  });

  const downloads = [];
  t.mock.method(window.HTMLAnchorElement.prototype, "click", function () {
    downloads.push({ url: this.href, name: this.download });
  });

  // Explicitly advance only the timer under test: no wall-clock sleeps,
  // lingering toast timers or accidental execution of unrelated callbacks.
  let timerId = 0;
  const timers = new Map();
  window.setTimeout = t.mock.fn((callback, delay) => {
    timers.set(++timerId, { callback, delay });
    return timerId;
  });
  window.clearTimeout = t.mock.fn((id) => timers.delete(id));
  const runTimers = (delay) => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay === delay && timers.delete(id)) timer.callback();
    }
  };

  const fetch = t.mock.fn(() => { throw new Error("Unexpected network request in a local image workflow"); });
  window.fetch = fetch;
  t.mock.method(window.XMLHttpRequest.prototype, "open", () => {
    throw new Error("Unexpected XMLHttpRequest in a local image workflow");
  });
  for (const [name, value] of Object.entries({
    window, document, URL: window.URL, Image: window.Image,
    // App IDs are UUIDs, which need no CSS escaping in this harness.
    CSS: { escape: (id) => id }, createImageBitmap: decode, fetch,
  })) install(name, value);

  return {
    window, document, createdUrls, revokedUrls, bitmaps, decode,
    canvases, getContext, encode, downloads, timers, runTimers, fetch,
    file: (name = "photo.png", type = "image/png", size = 1000) =>
      new window.File([new Uint8Array(size)], name, { type }),
    event(target, type, properties = {}) {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
      target.dispatchEvent(event);
      return event;
    },
    selectFiles(files) {
      const input = document.querySelector("#fileInput");
      Object.defineProperty(input, "files", { configurable: true, value: files });
      input.dispatchEvent(new window.Event("change"));
    },
  };
}

export async function loadApp(t, { loading = false } = {}) {
  const browser = await createBrowser(t);
  if (loading) Object.defineProperty(browser.document, "readyState", { value: "loading" });
  // Fresh app state per test, without changing production exports for testing.
  await import(`../../js/app.js?test=${++appImport}`);
  return browser;
}

export async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
}

export async function waitFor(predicate, message = "Expected asynchronous state was not reached") {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.ok(predicate(), message);
}

export async function waitForDone(browser, count = 1) {
  await waitFor(() => {
    const entries = [...browser.window.__pixelpress.entries.values()];
    return entries.length === count && entries.every((entry) => entry.status === "done");
  }, `Expected ${count} completed image(s)`);
  return [...browser.window.__pixelpress.entries.values()];
}
