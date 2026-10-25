import assert from "node:assert/strict";
import { test } from "node:test";
import { loadApp, waitFor, waitForDone, settle } from "./helpers/browser.js";

test("format and quality controls reflect PNG's lossless behavior", async (t) => {
  const browser = await loadApp(t);
  const { document } = browser;
  const format = document.querySelector("#formatSelect");
  const quality = document.querySelector("#qualityRange");
  const hint = document.querySelector("#qualityHint");
  format.value = "png";
  browser.event(format, "change");
  assert.equal(quality.disabled, true);
  assert.equal(hint.classList.contains("is-warning"), true);
  assert.match(hint.textContent, /PNG is lossless/);
  format.value = "keep";
  browser.event(format, "change");
  assert.equal(quality.disabled, false);
  assert.equal(hint.classList.contains("is-warning"), false);
  assert.match(hint.textContent, /JPEG and WebP/);
  quality.value = "65";
  browser.event(quality, "input");
  assert.equal(document.querySelector("#qualityValue").textContent, "65%");
  assert.equal([...browser.timers.values()].filter((timer) => timer.delay === 280).length, 1);
});

test("dropzone opens the file picker by click, Enter and Space only", async (t) => {
  const browser = await loadApp(t);
  const input = browser.document.querySelector("#fileInput");
  const click = t.mock.method(input, "click", () => {});
  const dropzone = browser.document.querySelector("#dropzone");
  dropzone.click();
  assert.equal(browser.event(dropzone, "keydown", { key: "Enter" }).defaultPrevented, true);
  assert.equal(browser.event(dropzone, "keydown", { key: " " }).defaultPrevented, true);
  browser.event(dropzone, "keydown", { key: "Tab" });
  assert.equal(click.mock.callCount(), 3);
});

test("drag highlighting survives moving over children and is cleared on leaving or dropping", async (t) => {
  const browser = await loadApp(t);
  const dropzone = browser.document.querySelector("#dropzone");
  const dataTransfer = { files: [], dropEffect: "none" };
  const event = browser.event(dropzone, "dragover", { dataTransfer });
  assert.equal(event.defaultPrevented, true);
  assert.equal(dataTransfer.dropEffect, "copy");
  assert.equal(dropzone.classList.contains("is-dragover"), true);
  browser.event(dropzone, "dragleave", { relatedTarget: dropzone.querySelector("h2") });
  assert.equal(dropzone.classList.contains("is-dragover"), true);
  browser.event(dropzone, "dragleave", { relatedTarget: browser.document.body });
  assert.equal(dropzone.classList.contains("is-dragover"), false);
  browser.event(browser.window, "dragenter");
  assert.equal(browser.document.body.classList.contains("is-dragging"), true);
  browser.event(browser.window, "dragleave", { relatedTarget: null });
  assert.equal(browser.document.body.classList.contains("is-dragging"), false);
});

for (const path of ["dropzone files", "window items", "paste"]) {
  test(`images are imported exactly once via ${path}`, async (t) => {
    const browser = await loadApp(t);
    const file = browser.file();
    let event;
    if (path === "dropzone files") {
      event = browser.event(browser.document.querySelector("#dropzone"), "drop", { dataTransfer: { files: [file] } });
    } else if (path === "window items") {
      event = browser.event(browser.window, "drop", { dataTransfer: { items: [
        { kind: "string", getAsFile: () => { throw new Error("Not a file"); } },
        { kind: "file", getAsFile: () => null }, { kind: "file", getAsFile: () => file },
      ] } });
    } else {
      event = browser.event(browser.document, "paste", { clipboardData: { files: [file] } });
    }
    const [image] = await waitForDone(browser);
    assert.equal(image.file, file);
    assert.equal(browser.document.querySelectorAll(".card").length, 1);
    if (path !== "paste") assert.equal(event.defaultPrevented, true);
  });
}

test("empty file selections, drops and clipboard events do not add entries", async (t) => {
  const browser = await loadApp(t);
  browser.selectFiles([]);
  browser.event(browser.window, "drop");
  browser.event(browser.document, "paste");
  await settle();
  assert.equal(browser.window.__pixelpress.entries.size, 0);
  assert.equal(browser.decode.mock.callCount(), 0);
});

test("unsupported files produce a useful error card and cannot be downloaded or compared", async (t) => {
  const browser = await loadApp(t);
  browser.selectFiles([browser.file("document.pdf", "application/pdf")]);
  const card = browser.document.querySelector(".card");
  assert.match(card.querySelector('[data-role="status"]').textContent, /Unsupported file type/);
  assert.equal(card.querySelector('[data-role="download"]').disabled, true);
  assert.equal(browser.document.querySelector("#downloadAllBtn").disabled, true);
  assert.equal(browser.decode.mock.callCount(), 0);
  card.querySelector(".card-thumb").click();
  assert.equal(browser.document.querySelector("#compareModal").getAttribute("aria-hidden"), "true");
  assert.match(browser.document.querySelector("#toastRegion").textContent, /nothing to compare/);
});

test("corrupt images fail visibly without enabling downloads", async (t) => {
  const browser = await loadApp(t);
  browser.decode.mock.mockImplementation(async () => { throw new Error("Corrupt bitmap"); });
  globalThis.Image = class { set src(value) { queueMicrotask(() => this.onerror()); } };
  browser.selectFiles([browser.file("corrupt.png")]);
  await waitFor(() => browser.document.querySelector(".card.is-error"));
  await settle();
  const [image] = browser.window.__pixelpress.entries.values();
  assert.equal(image.status, "error");
  assert.equal(image.outputBlob, null);
  assert.match(image.errorMessage, /Could not decode/);
  assert.equal(browser.document.querySelector("#downloadAllBtn").disabled, true);
});

test("settings changes are debounced, recompress images and release the replaced output URL", async (t) => {
  const browser = await loadApp(t);
  browser.selectFiles([browser.file()]);
  const [image] = await waitForDone(browser);
  const previousUrl = image.outputUrl;
  const quality = browser.document.querySelector("#qualityRange");
  for (const value of [70, 60, 55]) {
    quality.value = String(value);
    browser.event(quality, "input");
  }
  const maxWidth = browser.document.querySelector("#maxWidthInput");
  maxWidth.value = "100";
  browser.event(maxWidth, "input");
  assert.equal(browser.encode.mock.callCount(), 1);
  browser.runTimers(280);
  await waitFor(() => image.outputUrl !== previousUrl);
  assert.equal(browser.encode.mock.callCount(), 2);
  assert.equal(image.outputWidth, 100);
  assert.equal(image.outputHeight, 50);
  assert.equal(browser.encode.mock.calls[1].arguments[2], 0.55);
  assert.deepEqual(browser.revokedUrls, [previousUrl]);
});

test("non-positive width settings leave the original dimensions unchanged", async (t) => {
  const browser = await loadApp(t);
  browser.document.querySelector("#maxWidthInput").value = "-10";
  browser.selectFiles([browser.file()]);
  const [image] = await waitForDone(browser);
  assert.equal(image.outputWidth, 400);
  assert.equal(image.outputHeight, 200);
});

test("failed encoding can be retried by changing output format", async (t) => {
  const browser = await loadApp(t);
  browser.encode.mock.mockImplementation((callback) => callback(null));
  browser.selectFiles([browser.file()]);
  await waitFor(() => [...browser.window.__pixelpress.entries.values()][0]?.status === "error");
  browser.encode.mock.mockImplementation((callback, mime) => callback(new Blob(["output"], { type: mime })));
  const format = browser.document.querySelector("#formatSelect");
  format.value = "webp";
  browser.event(format, "change");
  browser.runTimers(280);
  const [image] = await waitForDone(browser);
  assert.equal(image.outputMime, "image/webp");
  assert.equal(image.errorMessage, null);
  assert.equal(browser.document.querySelector(".card").classList.contains("is-error"), false);
});

test("single-image Download all uses the image directly without loading ZIP code", async (t) => {
  const browser = await loadApp(t);
  browser.selectFiles([browser.file("picture.png")]);
  const [image] = await waitForDone(browser);
  const scriptCount = browser.document.scripts.length;
  browser.document.querySelector("#downloadAllBtn").click();
  assert.deepEqual(browser.downloads, [{ url: image.outputUrl, name: "picture-compressed.jpg" }]);
  assert.equal(browser.document.scripts.length, scriptCount);
  assert.equal(browser.document.querySelectorAll("a[download]").length, 0);
});

function zipStub(browser) {
  const files = [];
  const options = [];
  class JSZip {
    file(name, blob) { files.push({ name, blob }); }
    async generateAsync(value) { options.push(value); return new Blob(["zip"], { type: "application/zip" }); }
  }
  browser.window.JSZip = JSZip;
  return { files, options, JSZip };
}

test("ZIP downloads keep colliding filenames unique and release the archive URL", async (t) => {
  const browser = await loadApp(t);
  const zip = zipStub(browser);
  browser.selectFiles([
    browser.file("photo.png"), browser.file("photo.jpg", "image/jpeg"), browser.file("photo.webp", "image/webp"),
  ]);
  const images = await waitForDone(browser, 3);
  const button = browser.document.querySelector("#downloadAllBtn");
  assert.equal(button.textContent, "Download all (3)");
  button.click();
  assert.equal(button.disabled, true);
  await waitFor(() => browser.downloads.length === 1);
  assert.deepEqual(zip.files.map((file) => file.name), ["photo-compressed.jpg", "photo-compressed-2.jpg", "photo-compressed-3.jpg"]);
  assert.deepEqual(zip.files.map((file) => file.blob), images.map((image) => image.outputBlob));
  assert.deepEqual(zip.options, [{ type: "blob", compression: "STORE" }]);
  assert.equal(browser.downloads[0].name, "pixelpress-images.zip");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Download all (3)");
  browser.runTimers(4000);
  assert.deepEqual(browser.revokedUrls, [browser.downloads[0].url]);
});

for (const cdnWorks of [true, false]) {
  test(`missing JSZip ${cdnWorks ? "is loaded dynamically" : "falls back to individual downloads"}`, async (t) => {
    const browser = await loadApp(t);
    const zip = zipStub(browser);
    delete browser.window.JSZip;
    const append = browser.document.head.appendChild;
    t.mock.method(browser.document.head, "appendChild", function (element) {
      const result = append.call(this, element);
      if (element.tagName === "SCRIPT") queueMicrotask(() => {
        if (cdnWorks) browser.window.JSZip = zip.JSZip;
        element.dispatchEvent(new browser.window.Event(cdnWorks ? "load" : "error"));
      });
      return result;
    });
    browser.selectFiles([browser.file("one.png"), browser.file("two.png")]);
    await waitForDone(browser, 2);
    browser.document.querySelector("#downloadAllBtn").click();
    await settle();
    if (cdnWorks) {
      assert.equal(browser.downloads[0].name, "pixelpress-images.zip");
    } else {
      browser.runTimers(0);
      browser.runTimers(350);
      assert.deepEqual(browser.downloads.map((file) => file.name), ["one-compressed.jpg", "two-compressed.jpg"]);
      assert.match(browser.document.querySelector("#toastRegion").textContent, /one by one/);
    }
    assert.equal(browser.document.querySelector("#downloadAllBtn").disabled, false);
  });
}

test("removing an image closes its comparison and revokes each distinct URL exactly once", async (t) => {
  const browser = await loadApp(t);
  browser.selectFiles([browser.file()]);
  const [image] = await waitForDone(browser);
  const urls = [image.originalUrl, image.outputUrl];
  const card = browser.document.querySelector(".card");
  card.querySelector(".card-thumb").click();
  card.querySelector(".icon-btn").click();
  assert.deepEqual(browser.revokedUrls, urls);
  assert.equal(image.thumbnailUrl, null);
  assert.equal(image.originalUrl, null);
  assert.equal(image.outputUrl, null);
  assert.equal(browser.document.querySelector("#compareModal").getAttribute("aria-hidden"), "true");
  assert.equal(browser.document.querySelectorAll(".card").length, 0);
  assert.equal(browser.window.__pixelpress.entries.size, 0);
  browser.document.querySelector("#clearAllBtn").click();
  assert.deepEqual(browser.revokedUrls, urls);
});

for (const succeeds of [true, false]) {
  test(`removing a processing image preserves another image's ${succeeds ? "successful result" : "encoding error"}`, async (t) => {
    const browser = await loadApp(t);
    const pending = [];
    browser.encode.mock.mockImplementation((callback, mime) => pending.push({ callback, mime }));
    browser.selectFiles([browser.file("remove.png"), browser.file("keep.png")]);
    await waitFor(() => pending.length === 2);
    const [removed, remaining] = browser.window.__pixelpress.entries.values();
    const removedUrl = removed.originalUrl;
    const [removedCard, remainingCard] = browser.document.querySelectorAll(".card");
    removedCard.querySelector(".icon-btn").click();

    // The removed entry's late result must not create an output URL or revive its card.
    pending[0].callback(new Blob(["removed"], { type: pending[0].mime }));
    await settle();
    assert.equal(browser.window.__pixelpress.entries.has(removed.id), false);
    assert.equal(browser.document.querySelectorAll(".card").length, 1);
    assert.equal(removed.outputUrl, null);
    assert.equal(browser.createdUrls.length, 2);
    assert.deepEqual(browser.revokedUrls, [removedUrl]);

    const blob = succeeds ? new Blob(["remaining"], { type: pending[1].mime }) : null;
    pending[1].callback(blob);
    await settle();
    assert.equal(remaining.status, succeeds ? "done" : "error");
    assert.equal(remaining.outputBlob, blob);
    assert.equal(remainingCard.querySelector(".spinner"), null);
    assert.equal(remainingCard.querySelector('[data-role="download"]').disabled, !succeeds);
    assert.equal(browser.document.querySelector("#downloadAllBtn").disabled, !succeeds);
    if (succeeds) {
      remainingCard.querySelector('[data-role="download"]').click();
      assert.deepEqual(browser.downloads, [{ url: remaining.outputUrl, name: "keep-compressed.jpg" }]);
    } else {
      assert.match(remainingCard.querySelector('[data-role="status"]').textContent, /could not encode/);
    }
    assert.equal(browser.encode.mock.callCount(), 2);
    assert.equal(browser.bitmaps.every((bitmap) => bitmap.close.mock.callCount() === 1), true);
  });
}

test("removing a completed image does not cancel other images still being compressed", async (t) => {
  const browser = await loadApp(t);
  const pending = [];
  browser.encode.mock.mockImplementation((callback, mime) => pending.push({ callback, mime }));
  browser.selectFiles([browser.file("finished.png"), browser.file("pending.png")]);
  await waitFor(() => pending.length === 2);
  const [removed, remaining] = browser.window.__pixelpress.entries.values();
  pending[0].callback(new Blob(["finished"], { type: pending[0].mime }));
  await waitFor(() => removed.status === "done");
  const removedUrls = [removed.originalUrl, removed.outputUrl];
  browser.document.querySelector(".card .icon-btn").click();
  assert.deepEqual(browser.revokedUrls, removedUrls);

  pending[1].callback(new Blob(["remaining"], { type: pending[1].mime }));
  await settle();
  assert.equal(remaining.status, "done");
  assert.equal(browser.window.__pixelpress.entries.size, 1);
  assert.equal(browser.document.querySelectorAll(".card").length, 1);
  assert.equal(browser.document.querySelector("#downloadAllBtn").disabled, false);
  assert.equal(browser.encode.mock.callCount(), 2);
});

test("clearing a running batch discards late compression results without creating output URLs", async (t) => {
  const browser = await loadApp(t);
  const pending = [];
  browser.encode.mock.mockImplementation((callback) => pending.push(callback));
  browser.selectFiles([browser.file()]);
  await waitFor(() => pending.length === 1);
  browser.document.querySelector("#clearAllBtn").click();
  pending[0](new Blob(["late output"]));
  await settle();
  assert.equal(browser.window.__pixelpress.entries.size, 0);
  assert.equal(browser.document.querySelectorAll(".card").length, 0);
  assert.equal(browser.createdUrls.length, 1);
  assert.deepEqual(browser.revokedUrls, [browser.createdUrls[0].url]);
  assert.equal(browser.bitmaps.every((bitmap) => bitmap.close.mock.callCount() === 1), true);
});

test("a newer settings run wins even when the previous encoder finishes last", async (t) => {
  const browser = await loadApp(t);
  const pending = [];
  browser.encode.mock.mockImplementation((callback, mime) => pending.push({ callback, mime }));
  browser.selectFiles([browser.file()]);
  await waitFor(() => pending.length === 1);
  const format = browser.document.querySelector("#formatSelect");
  format.value = "webp";
  browser.event(format, "change");
  browser.runTimers(280);
  await waitFor(() => pending.length === 2);
  pending[1].callback(new Blob(["new"], { type: pending[1].mime }));
  const [image] = await waitForDone(browser);
  const latestUrl = image.outputUrl;
  pending[0].callback(new Blob(["old"], { type: pending[0].mime }));
  await settle();
  assert.equal(image.outputMime, "image/webp");
  assert.equal(image.outputUrl, latestUrl);
  assert.equal(browser.createdUrls.length, 2);
  assert.equal(browser.revokedUrls.length, 0);
});
