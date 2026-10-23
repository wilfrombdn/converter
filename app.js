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
    if (to === "csv") return new Blob([XLSX.utils.sheet_to_csv(ws)], { type: "text/csv" });
    if (to === "json") return new Blob([JSON.stringify(XLSX.utils.sheet_to_json(ws), null, 2)], { type: "application/json" });
    if (to === "html") return htmlPage(XLSX.utils.sheet_to_html(ws, { header: "", footer: "" }), "Sheet");
    const out = XLSX.write(wb, { bookType: to, type: "array" });
    return new Blob([out], { type: "application/octet-stream" });
  };
}

// ---------- routes ----------
const IMG_IN = ["png", "jpg", "webp", "gif", "bmp", "svg", "avif", "heic", "heif"];
const AUD_IN = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "wma", "weba"];
const VID_IN = ["mp4", "mov", "webm", "mkv", "avi", "flv", "wmv", "m4v", "3gp"];
const SHEET_IN = ["xlsx", "xls", "csv", "ods", "json"];

const img = (type, q) => async f => canvasBlob(await imageToCanvas(f, type === "image/jpeg"), type, q);
const imgToPdf = async f => {
  await lib("jspdf");
  const c = await imageToCanvas(f, true);
  const d = new jspdf.jsPDF({ unit: "px", format: [c.width, c.height], orientation: c.width > c.height ? "l" : "p", hotfixes: ["px_scaling"] });
  d.addImage(c.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, c.width, c.height);
  return d.output("blob");
};

const CATS = [
  { id: "photos", name: "Photos", from: IMG_IN, routes: [
    { to: "png", fn: img("image/png") }, { to: "jpg", fn: img("image/jpeg", 0.92) },
    { to: "webp", fn: img("image/webp", 0.92) }, { to: "pdf", fn: imgToPdf } ] },
  { id: "video", name: "Videos", from: VID_IN, routes: ["mp4", "webm", "mkv", "gif", "mp3", "wav"].map(to => ({ to, fn: (f, c) => viaFF(f, to, c) })) },
  { id: "audio", name: "Audio", from: AUD_IN, routes: ["mp3", "wav", "ogg", "flac", "m4a"].map(to => ({ to, fn: (f, c) => viaFF(f, to, c) })) },
  { id: "docs", name: "Documents", from: ["pdf", "docx", "txt", "md"], routes: [
    { from: ["pdf"], to: "docx", fn: pdfToDocx },
    { from: ["pdf"], to: "txt", fn: pdfToTxt },
    { from: ["pdf"], to: "png", fn: pdfToPng },
    { from: ["docx"], to: "pdf", fn: async f => textToPdf(await docxText(f)) },
    { from: ["docx"], to: "txt", fn: async f => new Blob([await docxText(f)], { type: "text/plain" }) },
    { from: ["docx"], to: "html", fn: async f => { await lib("mammoth"); return htmlPage((await mammoth.convertToHtml({ arrayBuffer: await f.arrayBuffer() })).value, f.name); } },
    { from: ["txt", "md"], to: "pdf", fn: async f => textToPdf(await textOf(f)) },
    { from: ["txt", "md"], to: "docx", fn: async f => textToDocx(await textOf(f)) },
    { from: ["txt"], to: "html", fn: async f => htmlPage("<pre>" + escHtml(await textOf(f)) + "</pre>", f.name) },
    { from: ["md"], to: "html", fn: async f => { await lib("marked"); return htmlPage(marked.parse(await textOf(f)), f.name); } },
  ] },
  { id: "data", name: "Spreadsheets & Data", from: SHEET_IN, routes: ["xlsx", "csv", "json", "ods", "html"].map(to => ({ to, fn: sheetOut(to) })) },
];

// ---------- UI ----------
let cat = CATS[0];
const tabs = $("tabs"), target = $("target"), list = $("list"), drop = $("drop"), input = $("file");

function selectCat(c) {
  cat = c;
  [...tabs.children].forEach(b => b.setAttribute("aria-selected", b.dataset.id === c.id));
  const outs = [...new Set(c.routes.map(r => r.to))];
  target.innerHTML = outs.map(o => `<option value="${o}">${o.toUpperCase()}</option>`).join("");
  input.accept = c.from.map(e => "." + e).join(",");
  $("hint").textContent = "Accepts: " + c.from.map(e => e.toUpperCase()).join(", ");
  try { sessionStorage.setItem("cat", c.id); } catch {}
}
CATS.forEach(c => {
  const b = document.createElement("button");
  b.textContent = c.name; b.dataset.id = c.id; b.setAttribute("role", "tab");
  b.onclick = () => selectCat(c);
  tabs.appendChild(b);
});
try { selectCat(CATS.find(c => c.id === sessionStorage.getItem("cat")) || CATS[0]); } catch { selectCat(CATS[0]); }

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
  const route = c.routes.find(r => r.to === to && (!r.from || r.from.includes(from)));
  if (!c.from.includes(from) || !route || from === to) {
    const ok = [...new Set(c.routes.filter(r => !r.from || r.from.includes(from)).map(r => r.to))].filter(x => x !== from);
    st.textContent = !c.from.includes(from) ? `.${from} isn't a ${c.name} format` : `Can't convert .${from} to .${to}` + (ok.length ? `. Try: ${ok.join(", ")}` : "");
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
