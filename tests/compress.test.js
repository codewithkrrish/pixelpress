import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SUPPORTED_TYPES, isSupportedFile, formatBytes, resolveOutputMime,
  buildOutputName, decodeImage, compressImage, savingsPercent,
} from "../js/compress.js";
import { createBrowser } from "./helpers/browser.js";

test("supported image MIME types and filename fallbacks are accepted", () => {
  for (const type of SUPPORTED_TYPES) assert.equal(isSupportedFile({ type, name: "image" }), true, type);
  for (const extension of ["jpg", "JPEG", "png", "WEBP", "gif", "BMP"]) {
    for (const type of ["", "application/octet-stream"]) {
      assert.equal(isSupportedFile({ type, name: `photo.${extension}` }), true);
    }
  }
});

test("missing files and unsupported extensions are rejected", () => {
  for (const file of [null, undefined, {}, { name: "photo.heic" }, { name: "photo.svg" },
    { name: "document.pdf", type: "application/pdf" }, { name: "photo.png.exe" }, { name: "png" }]) {
    assert.equal(isSupportedFile(file), false);
  }
});

test("byte formatting handles units, rounding, zero and invalid values", () => {
  const cases = [
    [0, "0 B"], [1, "1.0 B"], [99, "99.0 B"], [100, "100 B"], [1023, "1023 B"],
    [1024, "1.0 KB"], [1536, "1.5 KB"], [1024 ** 2, "1.0 MB"],
    [1024 ** 3, "1.0 GB"], [1024 ** 4, "1024 GB"],
    [-1, "—"], [NaN, "—"], [Infinity, "—"], [undefined, "—"], ["1024", "—"],
  ];
  for (const [input, expected] of cases) assert.equal(formatBytes(input), expected, String(input));
});

test("explicit output format overrides the source format", () => {
  for (const [format, expected] of [["jpeg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]]) {
    for (const source of SUPPORTED_TYPES) assert.equal(resolveOutputMime({ format }, source), expected);
  }
});

test("keep preserves encodable formats and normalizes GIF, BMP and unknown types to PNG", () => {
  for (const source of ["image/jpeg", "image/png", "image/webp"]) {
    assert.equal(resolveOutputMime({ format: "keep" }, source), source);
  }
  for (const source of ["image/gif", "image/bmp", "image/x-ms-bmp", "", undefined, "application/octet-stream"]) {
    assert.equal(resolveOutputMime({ format: "keep" }, source), "image/png");
  }
});

test("output filenames replace only the last extension and supply safe defaults", () => {
  for (const [name, mime, expected] of [
    ["photo.PNG", "image/jpeg", "photo-compressed.jpg"],
    ["holiday.photo.jpg", "image/webp", "holiday.photo-compressed.webp"],
    ["no-extension", "image/png", "no-extension-compressed.png"],
    ["Urlaub 2026.jpg", "image/png", "Urlaub 2026-compressed.png"],
    ["", "image/jpeg", "image-compressed.jpg"],
    [undefined, "image/webp", "image-compressed.webp"],
    ["photo.png", "unknown", "photo-compressed.jpg"],
  ]) assert.equal(buildOutputName(name, mime), expected);
});

test("savings include unchanged, empty and larger outputs", () => {
  assert.equal(savingsPercent(1000, 250), 75);
  assert.equal(savingsPercent(1000, 1000), 0);
  assert.equal(savingsPercent(1000, 1250), -25);
  assert.equal(savingsPercent(0, 100), 0);
});

test("bitmap decoding reports dimensions and closes its resource", async (t) => {
  const browser = await createBrowser(t);
  const file = browser.file();
  const decoded = await decodeImage(file);
  assert.equal(browser.decode.mock.calls[0].arguments[0], file);
  assert.equal(decoded.source, browser.bitmaps[0]);
  assert.equal(decoded.width, 400);
  assert.equal(decoded.height, 200);
  decoded.cleanup();
  assert.equal(browser.bitmaps[0].close.mock.callCount(), 1);
  assert.equal(browser.createdUrls.length, 0);
});

for (const bitmapAvailable of [true, false]) {
  test(`Image fallback works when bitmap decoding ${bitmapAvailable ? "rejects" : "is unavailable"}`, async (t) => {
    const browser = await createBrowser(t);
    if (bitmapAvailable) browser.decode.mock.mockImplementation(async () => { throw new Error("Unsupported bitmap"); });
    else globalThis.createImageBitmap = undefined;
    globalThis.Image = class {
      naturalWidth = 320;
      naturalHeight = 240;
      set src(value) { this.url = value; queueMicrotask(() => this.onload()); }
    };
    const decoded = await decodeImage(browser.file());
    assert.equal(decoded.width, 320);
    assert.equal(decoded.height, 240);
    assert.equal(decoded.source.url, browser.createdUrls[0].url);
    assert.deepEqual(browser.revokedUrls, []);
    decoded.cleanup();
    assert.deepEqual(browser.revokedUrls, [browser.createdUrls[0].url]);
  });
}

test("failed Image decoding rejects clearly and revokes its temporary URL", async (t) => {
  const browser = await createBrowser(t);
  browser.decode.mock.mockImplementation(async () => { throw new Error("Bad bitmap"); });
  globalThis.Image = class { set src(value) { queueMicrotask(() => this.onerror()); } };
  await assert.rejects(decodeImage(browser.file()), /Could not decode this image/);
  assert.deepEqual(browser.revokedUrls, [browser.createdUrls[0].url]);
});

test("JPEG compression rescales proportionally, flattens transparency and converts quality", async (t) => {
  const browser = await createBrowser(t);
  const result = await compressImage(browser.file(), { format: "jpeg", quality: 75, maxWidth: 100 });
  const { canvas, context } = browser.canvases[0];
  assert.deepEqual({ ...result, blob: undefined }, {
    blob: undefined, outputMime: "image/jpeg", width: 100, height: 50, originalWidth: 400, originalHeight: 200,
  });
  assert.equal(result.blob.type, "image/jpeg");
  assert.equal(canvas.width, 100);
  assert.equal(canvas.height, 50);
  assert.equal(context.fillStyle, "#ffffff");
  assert.deepEqual(context.fillRect.mock.calls[0].arguments, [0, 0, 100, 50]);
  assert.deepEqual(context.drawImage.mock.calls[0].arguments, [browser.bitmaps[0], 0, 0, 100, 50]);
  assert.equal(context.imageSmoothingEnabled, true);
  assert.equal(context.imageSmoothingQuality, "high");
  assert.deepEqual(browser.encode.mock.calls[0].arguments.slice(1), ["image/jpeg", 0.75]);
  assert.equal(browser.bitmaps[0].close.mock.callCount(), 1);
  assert.equal(browser.fetch.mock.callCount(), 0);
});

test("PNG output preserves transparency and does not pass lossy quality", async (t) => {
  const browser = await createBrowser(t);
  const result = await compressImage(browser.file(), { format: "png", quality: 10, maxWidth: null });
  assert.equal(result.outputMime, "image/png");
  assert.equal(browser.canvases[0].context.fillRect.mock.callCount(), 0);
  assert.deepEqual(browser.encode.mock.calls[0].arguments.slice(1), ["image/png", undefined]);
});

test("WebP output preserves transparency and receives quality on the Canvas scale", async (t) => {
  const browser = await createBrowser(t);
  const result = await compressImage(browser.file(), { format: "webp", quality: 90, maxWidth: null });
  assert.equal(result.outputMime, "image/webp");
  assert.equal(browser.canvases[0].context.fillRect.mock.callCount(), 0);
  assert.deepEqual(browser.encode.mock.calls[0].arguments.slice(1), ["image/webp", 0.9]);
});

test("max width never upscales and ignores absent, invalid and non-positive limits", async (t) => {
  const browser = await createBrowser(t);
  for (const maxWidth of [null, undefined, 0, -1, NaN, Infinity, 400, 800]) {
    const result = await compressImage(browser.file(), { format: "png", quality: 80, maxWidth });
    assert.equal(result.width, 400, String(maxWidth));
    assert.equal(result.height, 200, String(maxWidth));
  }
});

test("downscaling rounds dimensions and keeps very thin images at least one pixel high", async (t) => {
  const browser = await createBrowser(t);
  browser.decode.mock.mockImplementation(async () => ({ width: 1000, height: 1, close() {} }));
  const thin = await compressImage(browser.file(), { format: "png", quality: 80, maxWidth: 1 });
  assert.equal(thin.width, 1);
  assert.equal(thin.height, 1);
  browser.decode.mock.mockImplementation(async () => ({ width: 401, height: 201, close() {} }));
  const rounded = await compressImage(browser.file(), { format: "png", quality: 80, maxWidth: 100 });
  assert.equal(rounded.height, 50);
});

for (const failure of ["context", "null blob", "encoder throws", "drawing throws"]) {
  test(`compression releases decoded resources when ${failure} fails`, async (t) => {
    const browser = await createBrowser(t);
    let expected;
    if (failure === "context") {
      browser.getContext.mock.mockImplementation(() => null);
      expected = /Canvas is not available/;
    } else if (failure === "null blob") {
      browser.encode.mock.mockImplementation((callback) => callback(null));
      expected = /could not encode this image as JPEG/;
    } else if (failure === "encoder throws") {
      browser.encode.mock.mockImplementation(() => { throw new Error("Encoder failure"); });
      expected = /Encoder failure/;
    } else {
      browser.getContext.mock.mockImplementation(() => ({
        fillRect() {}, drawImage() { throw new Error("Drawing failure"); },
      }));
      expected = /Drawing failure/;
    }
    await assert.rejects(compressImage(browser.file(), { format: "jpeg", quality: 80, maxWidth: null }), expected);
    assert.equal(browser.bitmaps[0].close.mock.callCount(), 1);
  });
}
