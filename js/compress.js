/**
 * compress.js — Canvas-based image compression.
 *
 * Why this module exists separately from the UI:
 * Compression is pure logic (file in, blob out) with no DOM rendering concerns.
 * Keeping it isolated makes the failure modes explicit and keeps app.js focused
 * on state and wiring.
 *
 * Privacy invariant: nothing here performs network requests. Files are decoded
 * and re-encoded locally via the Canvas API.
 */

export const SUPPORTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  // Some browsers report BMP with this legacy MIME type.
  "image/x-ms-bmp",
]);

export const FORMAT_TO_MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export const MIME_TO_EXTENSION = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
};

export function isSupportedFile(file) {
  if (!file) return false;
  if (SUPPORTED_TYPES.has(file.type)) return true;
  // Fallback for files whose browser supplied an empty/generic MIME type
  // (happens for some BMPs dragged from certain file managers).
  return /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name || "");
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

/**
 * Decide the output MIME type.
 * "keep" respects the source format, except BMP/GIF which are normalised:
 * - GIF: canvas only exposes the first frame, so re-encoding as GIF is not
 *   possible via toBlob in a meaningful animated sense; PNG preserves the still.
 * - BMP: not encodable by canvas in most browsers, so PNG is the safe lossless target.
 */
export function resolveOutputMime(settings, sourceMime) {
  if (settings.format !== "keep") {
    return FORMAT_TO_MIME[settings.format];
  }
  if (sourceMime === "image/jpeg" || sourceMime === "image/png" || sourceMime === "image/webp") {
    return sourceMime;
  }
  return "image/png";
}

export function buildOutputName(originalName, outputMime) {
  const base = (originalName || "image").replace(/\.[^.]+$/, "");
  const ext = MIME_TO_EXTENSION[outputMime] || "jpg";
  return `${base}-compressed.${ext}`;
}

/**
 * Decode a File into a drawable image source plus its intrinsic size.
 * createImageBitmap is preferred because it decodes off the main thread and
 * reports dimensions without inserting an <img> into the document.
 */
export async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close?.() };
    } catch {
      // Fall through to the <img> path — some formats (notably some BMP/GIF
      // variants) fail in createImageBitmap but decode fine in an Image element.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not decode this image. The file may be corrupt or unsupported."));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/** Promisified canvas.toBlob with an explicit null guard. */
function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        // toBlob can legitimately return null (unsupported type, tainted or
        // zero-size canvas). Treat it as a real error, not a silent no-op.
        if (!blob) {
          reject(new Error(`Your browser could not encode this image as ${mime.replace("image/", "").toUpperCase()}.`));
          return;
        }
        resolve(blob);
      },
      mime,
      quality,
    );
  });
}

function computeTargetSize(width, height, maxWidth) {
  if (!maxWidth || !Number.isFinite(maxWidth) || maxWidth <= 0) {
    return { width, height };
  }
  // Never upscale: a max-width is a ceiling, not a target.
  if (width <= maxWidth) return { width, height };
  const scale = maxWidth / width;
  return { width: Math.round(width * scale), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Compress one file with the given settings.
 * @param {File} file
 * @param {{format: string, quality: number, maxWidth: number|null}} settings
 *   quality is 10–100 (UI scale); it is converted to the 0–1 canvas scale here.
 * @returns {Promise<{blob: Blob, outputMime: string, width: number, height: number,
 *                    originalWidth: number, originalHeight: number}>}
 */
export async function compressImage(file, settings) {
  const decoded = await decodeImage(file);
  try {
    const { width: targetWidth, height: targetHeight } = computeTargetSize(
      decoded.width,
      decoded.height,
      settings.maxWidth,
    );

    const outputMime = resolveOutputMime(settings, file.type || "image/png");

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available in this browser.");

    // JPEG has no alpha channel. Without this fill, transparent pixels from a
    // PNG/WebP/GIF source turn black. White matches how most viewers and
    // editors present a flattened JPEG, so it is the least surprising result.
    if (outputMime === "image/jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetWidth, targetHeight);
    }

    // High-quality downscaling hint; harmless where unsupported.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);

    // PNG is lossless — quality is intentionally ignored by the encoder.
    const qualityArg = outputMime === "image/png" ? undefined : settings.quality / 100;
    const blob = await canvasToBlob(canvas, outputMime, qualityArg);

    return {
      blob,
      outputMime,
      width: targetWidth,
      height: targetHeight,
      originalWidth: decoded.width,
      originalHeight: decoded.height,
    };
  } finally {
    decoded.cleanup();
  }
}

export function savingsPercent(originalSize, outputSize) {
  if (!originalSize) return 0;
  return ((originalSize - outputSize) / originalSize) * 100;
}
