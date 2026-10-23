"use strict";
const $ = id => document.getElementById(id);

// ---------- lazy library loading ----------
const LIBS = {
  pdfjs: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  docx: "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js",
  jspdf: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  mammoth: "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js",
  jszip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  xlsx: "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  heic: "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js",
  yaml: "https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js",
  marked: "https://cdnjs.cloudflare.com/ajax/libs/marked/4.3.0/marked.min.js",
  ffmpeg: "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js",
};
const loaded = {};
function lib(name) {
  return loaded[name] ||= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = LIBS[name];
    s.onload = res;
    s.onerror = () => { delete loaded[name]; rej(new Error("could not load " + name)); };
    document.head.appendChild(s);
  });
}
async function pdfjs() {
  await lib("pdfjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return pdfjsLib;
}

// ---------- helpers ----------
const extOf = n => { const e = n.split(".").pop().toLowerCase(); return e === "jpeg" ? "jpg" : e === "htm" ? "html" : e === "markdown" ? "md" : e; };
const canvasBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

async function loadImage(file) {
  let blob = file;
  const e = extOf(file.name);
  if (e === "heic" || e === "heif") {
    await lib("heic");
    const out = await heic2any({ blob: file, toType: "image/png" });
    blob = Array.isArray(out) ? out[0] : out;
  }
  if (e === "svg") blob = new Blob([file], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { img, w: img.naturalWidth || 1024, h: img.naturalHeight || 1024 };
  } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}
async function imageToCanvas(file, white) {
  const { img, w, h } = await loadImage(file);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  if (white) { g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); }
  g.drawImage(img, 0, 0, w, h);
  return c;
}

// ---------- ffmpeg ----------
let ff = null, ffProgress = null;
async function getFF(status) {
  if (ff) return ff;
  status("Downloading converter engine (~30 MB)...");
  await lib("ffmpeg");
  const blobURL = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
  const A = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/", C = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/";
  const f = new FFmpegWASM.FFmpeg();
  f.on("progress", ({ progress }) => { if (ffProgress && progress >= 0 && progress <= 1) ffProgress(Math.round(progress * 100)); });
  await f.load({
    classWorkerURL: await blobURL(A + "814.ffmpeg.js", "text/javascript"),
    coreURL: await blobURL(C + "ffmpeg-core.js", "text/javascript"),
    wasmURL: await blobURL(C + "ffmpeg-core.wasm", "application/wasm"),
  });
  return ff = f;
}
const FF_ARGS = {
  mp4: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac"],
  mkv: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac"],
  webm: ["-c:v", "libvpx", "-b:v", "1M", "-c:a", "libvorbis"],
  gif: ["-vf", "fps=12,scale=480:-1:flags=lanczos", "-loop", "0"],
  mp3: ["-vn", "-c:a", "libmp3lame", "-q:a", "2"],
  wav: ["-vn"],
  ogg: ["-vn", "-c:a", "libvorbis", "-q:a", "5"],
  flac: ["-vn", "-c:a", "flac"],
  m4a: ["-vn", "-c:a", "aac", "-b:a", "192k"],
};
const MIME = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", gif: "image/gif", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4" };
async function viaFF(file, to, ctx) {
  const f = await getFF(ctx.status);
  ffProgress = p => ctx.status(`Converting ${p}%`);
  ctx.status("Converting...");
  const inName = "in." + extOf(file.name), outName = "out." + to;
  await f.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
  const code = await f.exec(["-i", inName, ...FF_ARGS[to], outName]);
  if (code !== 0) { await f.deleteFile(inName).catch(() => {}); throw new Error("ffmpeg could not convert this file"); }
  const data = await f.readFile(outName);
  await f.deleteFile(inName).catch(() => {}); await f.deleteFile(outName).catch(() => {});
  return new Blob([data.buffer], { type: MIME[to] });
}

// ---------- document helpers ----------
async function pdfLines(file, progress) {
  const lib_ = await pdfjs();
  const pdf = await lib_.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [], sizes = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    progress(`Page ${p}/${pdf.numPages}`);
    const tc = await (await pdf.getPage(p)).getTextContent();
    const items = tc.items.filter(i => i.str !== "").map(i => ({
      s: i.str, x: i.transform[4], y: i.transform[5],
      size: Math.abs(i.transform[3]) || i.height || 10,
      font: (tc.styles[i.fontName] || {}).fontFamily || "", name: i.fontName,
    }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const l = lines[lines.length - 1];
      if (l && Math.abs(l.y - it.y) < it.size * 0.4) l.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    lines.forEach(l => { l.items.sort((a, b) => a.x - b.x); l.size = Math.max(...l.items.map(i => i.size)); sizes.push(l.size); });
    pages.push(lines);
  }
  return { pages, sizes };
}

async function pdfToDocx(file, ctx) {
  await lib("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak } = docx;
  const { pages, sizes } = await pdfLines(file, ctx.status);
  const freq = {};
  sizes.forEach(s => { const k = Math.round(s); freq[k] = (freq[k] || 0) + 1; });
  const body = +Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0] || 10;
  const children = [];
  pages.forEach((lines, pi) => {
    let para = null, prev = null;
    const flush = () => { if (para) children.push(new Paragraph({ children: para.runs, heading: para.heading, spacing: { after: 120 } })); para = null; };
    if (pi > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    for (const l of lines) {
      const gap = prev ? prev.y - l.y : 0;
      const heading = l.size >= body * 1.5 ? HeadingLevel.HEADING_1 : l.size >= body * 1.2 ? HeadingLevel.HEADING_2 : undefined;
      if (!para || gap > l.size * 1.8 || heading !== para.heading || heading) { flush(); para = { runs: [], heading }; }
      else para.runs.push(new TextRun(" "));
      let lastEnd = null;
      for (const it of l.items) {
        const bold = /bold|black|heavy/i.test(it.font + it.name);
        const italic = /italic|oblique/i.test(it.font + it.name);
        const sp = lastEnd !== null && it.x - lastEnd > it.size * 0.15 && !/^\s/.test(it.s) ? " " : "";
        para.runs.push(new TextRun({ text: sp + it.s, bold, italics: italic, size: Math.round(it.size * 2) }));
        lastEnd = it.x + it.s.length * it.size * 0.5;
      }
      prev = l;
    }
    flush();
  });
  if (!children.length) throw new Error("no text found (scanned PDF?)");
  return Packer.toBlob(new Document({ sections: [{ children }] }));
}

async function pdfToTxt(file, ctx) {
  const { pages } = await pdfLines(file, ctx.status);
  const text = pages.map(ls => ls.map(l => l.items.map(i => i.s).join(" ")).join("\n")).join("\n\n");
  if (!text.trim()) throw new Error("no text found (scanned PDF?)");
  return new Blob([text], { type: "text/plain" });
}

async function pdfToPng(file, ctx) {
  const lib_ = await pdfjs();
  const pdf = await lib_.getDocument({ data: await file.arrayBuffer() }).promise;
  const blobs = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    ctx.status(`Page ${p}/${pdf.numPages}`);
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 2 });
    const c = document.createElement("canvas");
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    blobs.push(await canvasBlob(c, "image/png"));
  }
  if (blobs.length === 1) return blobs[0];
  await lib("jszip");
  const z = new JSZip();
  const base = file.name.replace(/\.[^.]+$/, "");
  blobs.forEach((b, i) => z.file(`${base}-page${i + 1}.png`, b));
  return { blob: await z.generateAsync({ type: "blob" }), ext: "zip" };
}

async function textOf(file) { return (await file.text()).replace(/\r\n/g, "\n"); }

async function textToPdf(text) {
  await lib("jspdf");
  const d = new jspdf.jsPDF({ unit: "pt", format: "a4" });
  d.setFont("helvetica"); d.setFontSize(11);
  let y = 60;
  for (const line of d.splitTextToSize(text, 451)) {
    if (y > 780) { d.addPage(); y = 60; }
    d.text(line, 72, y); y += 15;
  }
  return d.output("blob");
}
async function docxText(file) {
  await lib("mammoth");
  return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
}
async function textToDocx(text) {
  await lib("docx");
  const { Document, Packer, Paragraph } = docx;
  return Packer.toBlob(new Document({ sections: [{ children: text.split("\n").map(t => new Paragraph(t)) }] }));
}
const htmlPage = (body, title) => new Blob([`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`], { type: "text/html" });
const escHtml = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---------- spreadsheet / data ----------
async function readSheet(file) {
  await lib("xlsx");
  const e = extOf(file.name);
  if (e === "json") {
    let data = JSON.parse(await file.text());
    if (!Array.isArray(data)) data = [data];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "Sheet1");
    return wb;
  }
  return XLSX.read(await file.arrayBuffer(), { type: "array" });
}
function sheetOut(to) {
  return async file => {
    const wb = await readSheet(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (to === "tsv") return new Blob([XLSX.utils.sheet_to_csv(ws, { FS: "	" })], { type: "text/tab-separated-values" });
    if (to === "csv") return new Blob([XLSX.utils.sheet_to_csv(ws)], { type: "text/csv" });
    if (to === "json") return new Blob([JSON.stringify(XLSX.utils.sheet_to_json(ws), null, 2)], { type: "application/json" });
    if (to === "html") return htmlPage(XLSX.utils.sheet_to_html(ws, { header: "", footer: "" }), "Sheet");
    const out = XLSX.write(wb, { bookType: to, type: "array" });
    return new Blob([out], { type: "application/octet-stream" });
  };
}

// ---------- ImageMagick (wasm) ----------
const MAGICK = "https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.45/dist/";
let magickP = null;
function magick(status) {
  return magickP ||= (async () => {
    status("Downloading image engine (~15 MB)...");
    const M = await import(MAGICK + "index.js");
    const wasm = await (await fetch(MAGICK + "x86/magick.wasm")).arrayBuffer();
    await M.initializeImageMagick(new Uint8Array(wasm));
    return M;
  })().catch(e => { magickP = null; throw e; });
}
const MAGICK_NAMES = { jpg: "JPG", tif: "TIFF", tiff: "TIFF", targa: "TGA", dib: "DIB" };
const magickName = e => MAGICK_NAMES[e] || e.toUpperCase();
async function viaMagick(file, to, ctx) {
  const M = await magick(ctx.status);
  ctx.status("Converting...");
  const data = new Uint8Array(await file.arrayBuffer());
  const write = img => {
    if (to === "ico" && (img.width > 256 || img.height > 256)) img.resize(new M.MagickGeometry(256, 256));
    return img.write(magickName(to), d => d.slice());
  };
  const from = magickName(extOf(file.name));
  let out;
  try { out = M.ImageMagick.read(data, from, write); }
  catch { out = M.ImageMagick.read(data, write); }
  return new Blob([out], { type: "application/octet-stream" });
}

// ---------- Pandoc (wasm) ----------
// pandoc.wasm is >50 MB, which jsDelivr refuses to serve, so it comes from unpkg.
let pandocP = null;
function pandoc(status) {
  return pandocP ||= (async () => {
    status("Downloading document engine (~60 MB)...");
    const src = await (await fetch("https://cdn.jsdelivr.net/npm/pandoc-wasm@1.1.0/src/core.js")).text();
    const fixed = src.replace('"@bjorn3/browser_wasi_shim"', '"https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/+esm"');
    const mod = await import(URL.createObjectURL(new Blob([fixed], { type: "text/javascript" })));
    const wasm = await (await fetch("https://unpkg.com/pandoc-wasm@1.1.0/src/pandoc.wasm")).arrayBuffer();
    return mod.createPandocInstance(wasm);
  })().catch(e => { pandocP = null; throw e; });
}
const PD_IN = { docx: "docx", odt: "odt", rtf: "rtf", epub: "epub", fb2: "fb2", pptx: "pptx", md: "markdown", rst: "rst",
  adoc: "asciidoc", asciidoc: "asciidoc", tex: "latex", latex: "latex", ltx: "latex", html: "html", ipynb: "ipynb",
  org: "org", textile: "textile", typ: "typst", opml: "opml" };
const PD_OUT = { docx: "docx", odt: "odt", epub: "epub3", html: "html5", md: "markdown", rst: "rst", tex: "latex", txt: "plain",
  rtf: "rtf", pptx: "pptx", adoc: "asciidoc", org: "org", typ: "typst", fb2: "fb2", ipynb: "ipynb", textile: "textile", wiki: "mediawiki" };
const PD_BINARY = new Set(["docx", "odt", "epub", "pptx", "rtf", "fb2", "ipynb"]);
async function viaPandoc(file, to, ctx) {
  const p = await pandoc(ctx.status);
  ctx.status("Converting...");
  const from = PD_IN[extOf(file.name)], inName = "input." + extOf(file.name), outName = "output." + to;
  const opts = { from, to: PD_OUT[to], standalone: true, "output-file": outName, "input-files": [inName] };
  if (!PD_BINARY.has(to)) opts["extract-media"] = "media";
  const r = await p.convert(opts, null, { [inName]: file });
  let out = r.files[outName];
  if (out == null) throw new Error((r.stderr || "").trim().split("\n")[0] || "pandoc could not convert this file");
  if (typeof out === "string") out = new Blob([out], { type: "text/plain" });
  const media = Object.entries(r.mediaFiles || {});
  if (!media.length) return out;
  await lib("jszip");
  const z = new JSZip();
  z.file(file.name.replace(/\.[^.]+$/, "") + "." + to, out);
  media.forEach(([path, data]) => z.file(path, data));
  return { blob: await z.generateAsync({ type: "blob" }), ext: "zip" };
}

// ---------- subtitles ----------
const pad2 = n => String(n).padStart(2, "0");
function srtToVtt(text) {
  return "WEBVTT\n\n" + text.replace(/^﻿/, "").replace(/(\d+:\d+:\d+),(\d+)/g, "$1.$2");
}
function vttToSrt(text) {
  const out = [];
  for (const block of text.replace(/^﻿/, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const i = lines.findIndex(l => l.includes("-->"));
    if (i < 0) continue;
    const time = lines[i].replace(/(^|\s)(\d+:\d+\.\d+)/g, "$100:$2").replace(/(\d+):(\d+):(\d+)\.(\d+)/g, (m, h, mi, s, ms) => `${pad2(h)}:${mi}:${s},${ms}`)
      .replace(/(\d{2}:\d{2}:\d{2},\d+)\s+(?:align|position|line|size)[^\n]*$/, "$1");
    out.push(`${out.length + 1}\n${time}\n${lines.slice(i + 1).join("\n")}`);
  }
  return out.join("\n\n") + "\n";
}
const srtToTxt = text => text.replace(/^﻿/, "").split(/\n{2,}/).map(b => b.split("\n").filter(l => !/^\d+$/.test(l.trim()) && !l.includes("-->")).join("\n")).filter(Boolean).join("\n");

// ---------- html / yaml ----------
async function htmlText(file) {
  const doc = new DOMParser().parseFromString(await file.text(), "text/html");
  doc.querySelectorAll("script,style").forEach(n => n.remove());
  return (doc.body.innerText || doc.body.textContent).replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- routes ----------
// Each route lists the catalogue category ids (cats) it appears under.
const IMG_IN = ["png", "jpg", "webp", "gif", "bmp", "avif", "heic", "heif"];
const AUD_IN = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "wma"];
const VID_IN = ["mp4", "mov", "webm", "mkv", "avi", "flv", "wmv", "m4v", "3gp"];
const SHEET_IN = ["xlsx", "xls", "csv", "tsv", "ods", "json"];

const img = (type, q) => async f => canvasBlob(await imageToCanvas(f, type === "image/jpeg"), type, q);
const imgToPdf = async f => {
  await lib("jspdf");
  const c = await imageToCanvas(f, true);
  const d = new jspdf.jsPDF({ unit: "px", format: [c.width, c.height], orientation: c.width > c.height ? "l" : "p", hotfixes: ["px_scaling"] });
  d.addImage(c.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, c.width, c.height);
  return d.output("blob");
};
const R = (cats, from, to, fn) => ({ cats, from, to, fn });
const textBlob = (s, type = "text/plain") => new Blob([s], { type });
const IMG_OUT = { png: img("image/png"), jpg: img("image/jpeg", 0.92), webp: img("image/webp", 0.92), pdf: imgToPdf };

const ROUTES = [
  ...Object.entries(IMG_OUT).flatMap(([to, fn]) => [R([6], IMG_IN, to, fn), R([8], ["svg"], to, fn)]),
  ...["mp4", "webm", "mkv", "gif", "mp3", "wav"].map(to => R([11], VID_IN, to, (f, c) => viaFF(f, to, c))),
  ...["mp3", "wav", "ogg", "flac", "m4a"].map(to => R([9], AUD_IN, to, (f, c) => viaFF(f, to, c))),
  R([1, 2], ["pdf"], "docx", pdfToDocx),
  R([1, 2], ["pdf"], "txt", pdfToTxt),
  R([1, 2], ["pdf"], "png", pdfToPng),
  R([1, 2], ["docx"], "pdf", async f => textToPdf(await docxText(f))),
  R([1, 2], ["docx"], "txt", async f => textBlob(await docxText(f))),
  R([1, 2], ["docx"], "html", async f => { await lib("mammoth"); return htmlPage((await mammoth.convertToHtml({ arrayBuffer: await f.arrayBuffer() })).value, f.name); }),
  R([1], ["txt", "md"], "pdf", async f => textToPdf(await textOf(f))),
  R([1], ["txt", "md"], "docx", async f => textToDocx(await textOf(f))),
  R([1, 20], ["txt"], "html", async f => htmlPage("<pre>" + escHtml(await textOf(f)) + "</pre>", f.name)),
  R([1, 20], ["md"], "html", async f => { await lib("marked"); return htmlPage(marked.parse(await textOf(f)), f.name); }),
  R([20], ["html"], "txt", async f => textBlob(await htmlText(f))),
  R([20], ["html"], "pdf", async f => textToPdf(await htmlText(f))),
  ...["xlsx", "csv", "tsv", "json", "ods", "html"].map(to => R([3, 18], SHEET_IN, to, sheetOut(to))),
  R([18], ["json"], "yaml", async f => { await lib("yaml"); return textBlob(jsyaml.dump(JSON.parse(await f.text()))); }),
  R([18], ["yaml", "yml"], "json", async f => { await lib("yaml"); return textBlob(JSON.stringify(jsyaml.load(await f.text()), null, 2), "application/json"); }),
  R([12], ["srt"], "vtt", async f => textBlob(srtToVtt(await textOf(f)), "text/vtt")),
  R([12], ["vtt"], "srt", async f => textBlob(vttToSrt(await textOf(f)))),
  R([12], ["srt", "vtt"], "txt", async f => textBlob(srtToTxt(await textOf(f)))),
];

// Engine-backed routes come last so the faster built-in converters above win where both exist.
// ImageMagick: only formats that passed a write-then-read round trip in the browser build.
const MAGICK_IN = ["png", "jpg", "gif", "bmp", "dib", "tif", "tiff", "webp", "avif", "jxl", "jp2", "j2k", "ico", "psd", "pcx", "tga", "dds", "qoi", "exr", "hdr",
  "ppm", "pgm", "pbm", "pnm", "pam", "sgi", "ras", "xbm", "xpm", "pfm", "jng", "mng", "wbmp", "fits", "dpx", "cin"];
const MAGICK_OUT = ["png", "jpg", "gif", "bmp", "tiff", "ico", "tga", "avif", "jxl", "webp", "psd", "pcx", "ppm", "dds", "qoi", "exr", "hdr", "sgi", "ras", "jp2", "dpx"];
for (const to of MAGICK_OUT)
  ROUTES.push(R([6], MAGICK_IN.filter(e => e !== to && !(to === "tiff" && e === "tif")), to, (f, c) => viaMagick(f, to, c)));
// Pandoc: cats are resolved from the catalogue at start-up (cats: null).
for (const inExt of Object.keys(PD_IN))
  for (const to of Object.keys(PD_OUT))
    if (inExt !== to && PD_IN[inExt] !== PD_OUT[to]) ROUTES.push(R(null, [inExt], to, (f, c) => viaPandoc(f, to, c)));

// ---------- UI ----------
const tabs = $("tabs"), target = $("target"), list = $("list"), drop = $("drop"), input = $("file");
let cats = [], cat = null;

function selectCat(c) {
  cat = c;
  [...tabs.children].forEach(b => b.setAttribute("aria-selected", b.dataset.id == c.id));
  $("work").hidden = !c.live;
  $("info").hidden = c.live;
  if (c.live) {
    const outs = [...new Set(c.routes.map(r => r.to))];
    target.innerHTML = outs.map(o => `<option value="${o}">${o.toUpperCase()}</option>`).join("");
    input.accept = c.from.map(e => "." + e).join(",");
    $("hint").textContent = "Accepts: " + c.from.map(e => e.toUpperCase()).join(", ");
  } else {
    $("info").innerHTML = "";
    const h = document.createElement("h2"); h.textContent = c.name;
    const p = document.createElement("p");
    p.textContent = `Not available in the browser yet. Converting these needs ${c.engines || "specialised tools"}, which isn't wired into this page. ` + (c.notes || "");
    const q = document.createElement("p"); q.textContent = "Recognised extensions: " + c.extensions.map(e => "." + e).join(" ");
    q.style.color = "var(--muted)";
    $("info").append(h, p, q);
  }
  try { sessionStorage.setItem("cat", c.id); } catch {}
}

async function init() {
  const catalogue = await (await fetch("catalogue.json")).json();
  ROUTES.filter(r => !r.cats).forEach(r => {
    const hit = catalogue.filter(c => c.extensions.includes(r.from[0])).map(c => c.id);
    r.cats = hit.length ? hit : [20];
  });
  cats = catalogue.map(c => {
    const routes = ROUTES.filter(r => r.cats.includes(c.id));
    return { ...c, routes, live: routes.length > 0, from: [...new Set(routes.flatMap(r => r.from))] };
  });
  cats.forEach(c => {
    const b = document.createElement("button");
    b.textContent = c.name.replace(/ &.*|,.*/, "");
    b.title = c.name + (c.live ? "" : " (not available in the browser yet)");
    b.dataset.id = c.id; b.setAttribute("role", "tab");
    if (!c.live) b.classList.add("soon");
    b.onclick = () => selectCat(c);
    tabs.appendChild(b);
  });
  $("count").textContent = `${cats.filter(c => c.live).length} of ${cats.length} categories convert in your browser today; the rest are listed with what they would need.`;
  let start = cats.find(c => c.id === 1);
  try { start = cats.find(c => c.id == sessionStorage.getItem("cat")) || start; } catch {}
  selectCat(start);
}

$("pick").onclick = e => { e.stopPropagation(); input.click(); };
drop.onclick = () => input.click();
input.onchange = () => { handle([...input.files]); input.value = ""; };
drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); handle([...e.dataTransfer.files]); };

let chain = Promise.resolve();
function handle(files) {
  const to = target.value, c = cat;
  for (const f of files) {
    const li = document.createElement("li");
    li.innerHTML = "<b></b><span class='st'>Queued</span>";
    li.firstChild.textContent = f.name;
    list.appendChild(li);
    const st = li.querySelector(".st");
    chain = chain.then(() => run(f, c, to, st));
  }
}
async function run(f, c, to, st) {
  const from = extOf(f.name);
  const route = c.routes.find(r => r.to === to && r.from.includes(from));
  if (!route) {
    const ok = [...new Set(c.routes.filter(r => r.from.includes(from)).map(r => r.to))].filter(x => x !== from);
    const other = cats.find(o => o.live && o.routes.some(r => r.from.includes(from)));
    const known = cats.find(o => o.extensions.includes(from));
    st.textContent = ok.length ? `Can't convert .${from} to .${to}. Try: ${ok.join(", ")}`
      : other ? `.${from} belongs under "${other.name.replace(/ &.*|,.*/, "")}"`
      : known ? `.${from} is recognised (${known.name}) but has no in-browser converter yet`
      : `.${from} isn't in the catalogue`;
    return;
  }
  const status = t => { st.textContent = t; };
  status("Converting...");
  try {
    let out = await route.fn(f, { status });
    const ext = out.ext || to;
    out = out.blob || out;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(out);
    a.download = f.name.replace(/\.[^.]+$/, "") + "." + ext;
    a.textContent = "Download ." + ext;
    st.replaceChildren(a);
  } catch (err) {
    st.textContent = "Failed: " + (err.message || err);
  }
}
init();
