/**
 * Draws finished, on-brand post images in code — the "generated image is
 * not the final design" rule. Image models misspell Arabic, so they never
 * write text: they only produce a clean scene, and this file sets the
 * headline on top in Readex Pro / Manrope with the Rovira colors and logo.
 *
 * Two layouts, both 1080x1350 (4:5, Instagram's tallest feed format):
 *  - composeSceneCard: AI scene on top, deep-blue panel with the headline.
 *  - composeScreenshotCard: a REAL app screenshot inside a phone frame, on
 *    sand, with the headline above it.
 *
 * Returns a JPEG Buffer (Instagram's publishing API only accepts JPEG).
 * Pure drawing — no network, no Firestore, nothing external.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createCanvas, loadImage, GlobalFonts, Path2D } from "@napi-rs/canvas";
import { BRAND } from "../core/BrandKit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, "..", "..", "assets", "fonts");

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "ReadexPro_400Regular.ttf"), "Readex Pro");
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "ReadexPro_600SemiBold.ttf"), "Readex Pro SemiBold");
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "ReadexPro_700Bold.ttf"), "Readex Pro Bold");
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "Manrope_800ExtraBold.ttf"), "Manrope ExtraBold");
  fontsReady = true;
}

const W = 1080;
const H = 1350;
const PAD = 80;
const C = BRAND.colors;

// The ر + R mark, in its 0..100 design box (same paths as the design system).
const R_PATH = "M34 76 V26 H55 a16 16 0 0 1 0 32 H34";
const TAIL_PATH = "M50 58 C64 60 67 78 82 82";

function drawLogo(ctx, x, y, size, { tile = true } = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 100, size / 100);
  if (tile) {
    ctx.fillStyle = C.deep;
    roundRect(ctx, 0, 0, 100, 100, 24);
    ctx.fill();
  }
  ctx.translate(50, 50);
  ctx.scale(0.8, 0.8);
  ctx.translate(-58, -54);
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = C.spark;
  ctx.stroke(new Path2D(TAIL_PATH));
  ctx.strokeStyle = tile ? C.sand : C.deep;
  ctx.stroke(new Path2D(R_PATH));
  ctx.restore();
}

function drawWordmark(ctx, x, y, color) {
  drawLogo(ctx, x, y, 52);
  ctx.save();
  ctx.direction = "ltr";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.font = `32px "Manrope ExtraBold"`;
  ctx.fillText("Rovira", x + 66, y + 28);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Greedy word wrap that measures shaped Arabic text correctly. */
function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth || !line) {
      line = test;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
    return kept;
  }
  return lines;
}

/**
 * Draws right-aligned (RTL) text, shrinking the font until it fits in
 * maxLines. Returns the y just below the last line.
 */
function drawFittedText(ctx, text, { right, top, maxWidth, family, size, minSize, lineHeight, color, maxLines }) {
  let s = size;
  let lines;
  ctx.direction = "rtl";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  while (true) {
    ctx.font = `${s}px "${family}"`;
    lines = wrapLines(ctx, text, maxWidth, 99);
    if (lines.length <= maxLines || s <= minSize) break;
    s -= 4;
  }
  lines = wrapLines(ctx, text, maxWidth, maxLines);
  ctx.fillStyle = color;
  let y = top;
  for (const l of lines) {
    // Wrap in RLI…PDI (U+2067/U+2069): the renderer ignores ctx.direction
    // for the bidi base, so without this a line that starts with a Latin
    // word ("AI Agents ...") gets its runs laid out in the wrong order.
    ctx.fillText(`\u2067${l}\u2069`, right, y);
    y += s * lineHeight;
  }
  return y;
}

function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function toJpeg(canvas) {
  return canvas.toBuffer("image/jpeg", 92);
}

/**
 * AI scene + headline. `scene` is a Buffer or base64 string of the image
 * the model generated (portrait works best).
 */
export async function composeSceneCard(scene, { headline, subline = "" }) {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const img = await loadImage(Buffer.isBuffer(scene) ? scene : Buffer.from(scene, "base64"));

  const panelTop = 830;
  drawCover(ctx, img, 0, 0, W, panelTop);

  ctx.fillStyle = C.deep;
  ctx.fillRect(0, panelTop, W, H - panelTop);

  // The ر tail as a saffron accent riding the seam between scene and panel.
  ctx.save();
  ctx.strokeStyle = C.spark;
  ctx.lineWidth = 26;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(W + 40, panelTop - 70);
  ctx.bezierCurveTo(W - 180, panelTop - 60, W - 280, panelTop + 30, W - 520, panelTop + 46);
  ctx.stroke();
  ctx.restore();

  // Logo chip on the scene, top-left, on a sand plate so it reads on any photo.
  ctx.fillStyle = "rgba(244,238,227,0.92)";
  roundRect(ctx, PAD - 16, PAD - 16, 230, 84, 24);
  ctx.fill();
  drawWordmark(ctx, PAD, PAD, C.deep);

  let y = drawFittedText(ctx, headline, {
    right: W - PAD, top: panelTop + 90, maxWidth: W - PAD * 2,
    family: "Readex Pro Bold", size: 76, minSize: 52, lineHeight: 1.22, color: C.sand, maxLines: 2
  });
  if (subline) {
    drawFittedText(ctx, subline, {
      right: W - PAD, top: y + 18, maxWidth: W - PAD * 2,
      family: "Readex Pro", size: 32, minSize: 26, lineHeight: 1.5, color: C.mist, maxLines: 2
    });
  }

  ctx.direction = "ltr";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `24px "Manrope ExtraBold"`;
  ctx.fillStyle = C.spark;
  ctx.fillText(BRAND.website, PAD, H - 64);

  return toJpeg(canvas);
}

/**
 * Real screenshot in a phone frame + headline. `screenshot` is a Buffer
 * (or base64) of the real app screen from the brand asset library.
 */
export async function composeScreenshotCard(screenshot, { headline, subline = "", label = "" }) {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const img = await loadImage(Buffer.isBuffer(screenshot) ? screenshot : Buffer.from(screenshot, "base64"));

  ctx.fillStyle = C.sand;
  ctx.fillRect(0, 0, W, H);

  // Deep band at the bottom, the phone sits across it.
  const bandTop = 1010;
  ctx.fillStyle = C.deep;
  ctx.fillRect(0, bandTop, W, H - bandTop);

  ctx.save();
  ctx.strokeStyle = C.spark;
  ctx.lineWidth = 26;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-40, bandTop - 120);
  ctx.bezierCurveTo(180, bandTop - 110, 260, bandTop + 10, 520, bandTop + 40);
  ctx.stroke();
  ctx.restore();

  drawWordmark(ctx, PAD, PAD, C.deep);

  let y = drawFittedText(ctx, headline, {
    right: W - PAD, top: 190, maxWidth: W - PAD * 2,
    family: "Readex Pro Bold", size: 72, minSize: 50, lineHeight: 1.22, color: C.deep, maxLines: 2
  });
  if (subline) {
    drawFittedText(ctx, subline, {
      right: W - PAD, top: y + 10, maxWidth: W - PAD * 2,
      family: "Readex Pro SemiBold", size: 32, minSize: 26, lineHeight: 1.45, color: C.sparkInk, maxLines: 1
    });
  }

  // Phone frame. Wide (desktop/tablet) screenshots get a laptop-ish frame.
  const landscape = img.width > img.height * 1.1;
  const frameW = landscape ? 900 : 430;
  const frameH = landscape ? Math.round((frameW - 28) * (img.height / img.width)) + 28 : 860;
  const fx = (W - frameW) / 2;
  const fy = Math.min(bandTop - 40, H - 80 - frameH) - (landscape ? 0 : 60);
  const fyClamped = Math.max(y + 70, fy);

  ctx.save();
  ctx.shadowColor = "rgba(16,24,27,0.28)";
  ctx.shadowBlur = 48;
  ctx.shadowOffsetY = 20;
  ctx.fillStyle = C.ink;
  roundRect(ctx, fx, fyClamped, frameW, Math.min(frameH, H - fyClamped - 40), landscape ? 28 : 56);
  ctx.fill();
  ctx.restore();

  const inset = 14;
  const sx = fx + inset;
  const sy = fyClamped + inset;
  const sw = frameW - inset * 2;
  const sh = Math.min(frameH, H - fyClamped - 40) - inset * 2;
  ctx.save();
  roundRect(ctx, sx, sy, sw, sh, landscape ? 16 : 44);
  ctx.clip();
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(sx, sy, sw, sh);
  // Phones: fill width, anchor to top (status bar + header are the useful part).
  const scale = sw / img.width;
  ctx.drawImage(img, 0, 0, img.width, Math.min(img.height, sh / scale), sx, sy, sw, Math.min(img.height * scale, sh));
  ctx.restore();

  if (label) {
    ctx.direction = "rtl";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.font = `26px "Readex Pro SemiBold"`;
    ctx.fillStyle = C.sand;
    ctx.fillText(`\u2067${label}\u2069`, W - PAD, H - 60);
  }
  ctx.direction = "ltr";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `24px "Manrope ExtraBold"`;
  ctx.fillStyle = C.spark;
  ctx.fillText(BRAND.website, PAD, H - 60);

  return toJpeg(canvas);
}
