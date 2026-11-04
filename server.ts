import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Request, Response, NextFunction } from "express";
import multer from "multer";
import { exportDocument, FORMATS, OcrDocument, DocBlock, DocPage } from "./src/exporters.js";
import { getLineDetector, getRecognizer, processUploadedDocument, ProcessOptions } from "./src/pipeline.js";

const PORT = Number(process.env.PORT || process.env.NETRA_PORT || 3000);
const HOST = process.env.NETRA_HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.NETRA_DATA_DIR || ".cache/netra-ocr/jobs");
const MAX_UPLOAD_MB = Number(process.env.NETRA_MAX_UPLOAD_MB || 50);
const MAX_PDF_PAGES = Number(process.env.NETRA_MAX_PDF_PAGES || 100);
const JOB_TTL_HOURS = Number(process.env.NETRA_JOB_TTL_HOURS || 24);
const API_KEY = process.env.NETRA_API_KEY || "";
const DEFAULT_DETECTOR = process.env.NETRA_DETECTOR || "yolo";
const DEFAULT_DECODER = (process.env.NETRA_DECODER === "blockwise" ? "blockwise" : "ar") as "ar" | "blockwise";
const SYNC_TIMEOUT_MS = Number(process.env.NETRA_SYNC_TIMEOUT || 120) * 1000;

const DETECTORS = ["yolo", "legacy"];
const DECODERS = ["ar", "blockwise"];
const BLOCK_TYPES = new Set([
  "heading",
  "paragraph",
  "caption",
  "table",
  "figure",
  "formula",
  "page_header",
  "page_footer",
]);
const TEXT_TYPES = new Set(["heading", "paragraph", "caption", "page_header", "page_footer"]);
const ALIGNMENTS = new Set(["left", "center", "right", "justify"]);

fs.mkdirSync(DATA_DIR, { recursive: true });

interface JobRecord {
  id: string;
  filename: string;
  kind: string;
  options: ProcessOptions;
  status: "queued" | "running" | "done" | "error";
  pages_done: number;
  pages_total: number;
  error: string | null;
  created: number;
  updated: number;
  edited: boolean;
}

const jobs = new Map<string, JobRecord>();
let modelsReady = true;

function jobPublic(job: JobRecord) {
  return {
    id: job.id,
    filename: job.filename,
    kind: job.kind,
    options: job.options,
    status: job.status,
    error: job.error,
    created: job.created,
    updated: job.updated,
    edited: job.edited,
    progress: {
      done: job.pages_done,
      total: job.pages_total,
    },
  };
}

function jobDir(jobId: string): string {
  if (!/^[0-9a-f]{32}$/.test(jobId)) {
    throw new Error("Invalid job id");
  }
  return path.join(DATA_DIR, jobId);
}

function writeJobMeta(job: JobRecord) {
  job.updated = Date.now() / 1000;
  const dir = jobDir(job.id);
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, "job.json");
  fs.writeFileSync(metaPath, JSON.stringify(job, null, 2), "utf-8");
}

function saveDocFile(jobId: string, doc: OcrDocument, filename = "document.json") {
  const dir = jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(doc, null, 2), "utf-8");
}

function loadDocFile(jobId: string, original = false): OcrDocument {
  const dir = jobDir(jobId);
  const file = path.join(dir, original ? "document.ocr.json" : "document.json");
  if (!fs.existsSync(file)) {
    throw new Error("Document file missing");
  }
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function loadExistingJobs() {
  if (!fs.existsSync(DATA_DIR)) return;
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name, "job.json"), "utf-8"));
      if (raw.status === "queued" || raw.status === "running") {
        raw.status = "error";
        raw.error = "Interrupted by a server restart. Please upload again.";
      }
      jobs.set(raw.id, raw);
    } catch {
      // Ignore corrupt job directories
    }
  }
}

function sniffKind(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "png";
  }
  const head4 = buf.subarray(0, 4).toString("binary");
  if (head4 === "II*\x00" || head4 === "MM\x00*") return "tiff";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

function safeBasename(filename?: string): string {
  const base = path.parse(path.basename(filename || "document")).name;
  const cleaned = base.replace(/[^\w\-. \u1780-\u17FF]+/gu, "_").replace(/^[ ._]+|[ ._]+$/g, "");
  return (cleaned || "document").slice(0, 80);
}

function validateDocumentInput(data: any, assetsDir: string): { pages: DocPage[]; blocks: DocBlock[] } {
  if (!data || typeof data !== "object") {
    throw new Error("document must be an object");
  }
  if (!Array.isArray(data.pages) || !Array.isArray(data.blocks)) {
    throw new Error("document needs 'pages' and 'blocks' lists");
  }
  if (data.blocks.length > 20000) {
    throw new Error("too many blocks");
  }

  const pages: DocPage[] = data.pages.map((p: any, i: number) => {
    if (!p || typeof p !== "object") throw new Error(`pages[${i}] must be an object`);
    return {
      index: i,
      width: Math.trunc(Number(p.width || 0)),
      height: Math.trunc(Number(p.height || 0)),
      image: typeof p.image === "string" ? p.image : null,
    };
  });

  const hasAsset = (assetId: any, where: string): string | null => {
    if (assetId === null || assetId === undefined) return null;
    if (typeof assetId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(assetId)) {
      throw new Error(`${where}: unknown image ${JSON.stringify(assetId)}`);
    }
    const pngExists = fs.existsSync(path.join(assetsDir, `${assetId}.png`));
    const jpgExists = fs.existsSync(path.join(assetsDir, `${assetId}.jpg`));
    if (!pngExists && !jpgExists) {
      throw new Error(`${where}: unknown image ${JSON.stringify(assetId)}`);
    }
    return assetId;
  };

  const parseBbox = (v: any, where: string): [number, number, number, number] | null => {
    if (v === null || v === undefined) return null;
    if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error(`${where}: bbox must be [x1, y1, x2, y2]`);
    }
    return [Math.trunc(v[0]), Math.trunc(v[1]), Math.trunc(v[2]), Math.trunc(v[3])];
  };

  const parseText = (v: any, where: string): string => {
    if (typeof v !== "string") throw new Error(`${where}: text must be a string`);
    if (v.length > 100000) throw new Error(`${where}: text too long`);
    return v;
  };

  const seen = new Set<string>();
  const blocks: DocBlock[] = data.blocks.map((b: any, i: number) => {
    const where = `blocks[${i}]`;
    if (!b || typeof b !== "object") throw new Error(`${where} must be an object`);
    const btype = b.type;
    if (!BLOCK_TYPES.has(btype)) throw new Error(`${where}: unknown type ${JSON.stringify(btype)}`);
    const bid = b.id;
    if (typeof bid !== "string" || !bid || bid.length > 64 || seen.has(bid)) {
      throw new Error(`${where}: id must be a unique non-empty string`);
    }
    seen.add(bid);
    const page = b.page ?? 0;
    if (!Number.isInteger(page) || page < 0 || page >= Math.max(1, pages.length)) {
      throw new Error(`${where}: page out of range`);
    }

    const out: DocBlock = {
      id: bid,
      type: btype,
      page,
      bbox: parseBbox(b.bbox, where),
    };
    if (typeof b.label === "string") out.label = b.label.slice(0, 32);
    if (Array.isArray(b.lines)) {
      out.lines = b.lines
        .filter((l: any) => l && typeof l === "object")
        .map((l: any) => ({
          text: parseText(l.text ?? "", where),
          bbox: parseBbox(l.bbox, where),
        }));
    }

    if (TEXT_TYPES.has(btype)) {
      out.text = parseText(b.text ?? "", where);
      const align = b.align ?? "left";
      if (!ALIGNMENTS.has(align)) {
        throw new Error(`${where}: align must be one of center, justify, left, right`);
      }
      out.align = align;
      if (btype === "heading") {
        const level = b.level ?? 1;
        if (level !== 1 && level !== 2 && level !== 3) {
          throw new Error(`${where}: heading level must be 1-3`);
        }
        out.level = level;
      }
    } else if (btype === "table") {
      const rows = b.rows;
      if (!Array.isArray(rows) || rows.length === 0 || !rows.every((r: any) => Array.isArray(r) && r.length > 0)) {
        throw new Error(`${where}: table rows must be a non-empty list of lists`);
      }
      const width = Math.max(...rows.map((r: any[]) => r.length));
      out.rows = rows.map((r: any[]) => {
        const clean = r.map((c) => parseText(c, where));
        while (clean.length < width) clean.push("");
        return clean;
      });
      out.image = hasAsset(b.image, where);
      if (typeof b.caption === "string") out.caption = parseText(b.caption, where);
    } else {
      out.image = hasAsset(b.image, where);
      if (!out.image) throw new Error(`${where}: ${btype} needs an image`);
    }
    return out;
  });

  return { pages, blocks };
}

async function seedSampleJobsIfEmpty() {
  if (jobs.size > 0) return;
  const samplesDir = path.resolve("samples");
  if (!fs.existsSync(samplesDir)) return;

  const sampleFiles = [
    { file: "test_doc.jpg", name: "moh_announcement_2021" },
    { file: "id_card.png", name: "khmer_national_id_card" },
    { file: "odc.jpg", name: "moi_hologram_id_notice" },
  ];

  let offsetSeconds = 3600;
  for (const item of sampleFiles) {
    const filePath = path.join(samplesDir, item.file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = fs.readFileSync(filePath);
      const kind = sniffKind(data) || "jpeg";
      const id = crypto.randomBytes(16).toString("hex");
      const now = Date.now() / 1000 - offsetSeconds;
      offsetSeconds -= 900;
      const options: ProcessOptions = {
        layout: true,
        detector: "yolo",
        decoder: "ar",
        include_headers_footers: true,
        conf: null,
      };
      const job: JobRecord = {
        id,
        filename: item.name,
        kind,
        options,
        status: "done",
        pages_done: 1,
        pages_total: 1,
        error: null,
        created: now,
        updated: now,
        edited: false,
      };
      const d = jobDir(id);
      fs.mkdirSync(d, { recursive: true });
      const doc = await processUploadedDocument(data, item.file, kind, d, options);
      saveDocFile(id, doc, "document.ocr.json");
      saveDocFile(id, doc, "document.json");
      jobs.set(id, job);
      writeJobMeta(job);
      job.created = now;
      job.updated = now;
    } catch (err) {
      console.warn("Skipping sample seed:", item.file, err);
    }
  }
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 + 1024 },
});

// Optional API key middleware on /v1/*
app.use((req: Request, res: Response, next: NextFunction) => {
  if (API_KEY && req.path.startsWith("/v1/")) {
    let supplied = (req.header("x-api-key") || "").trim();
    const auth = req.header("authorization") || "";
    if (auth.toLowerCase().startsWith("bearer ")) {
      supplied = auth.slice(7).trim();
    }
    if (!supplied && req.method === "GET" && typeof req.query.key === "string") {
      supplied = req.query.key;
    }
    const a = Buffer.from(supplied);
    const b = Buffer.from(API_KEY);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ detail: "Missing or invalid API key." });
      return;
    }
  }
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, models_ready: modelsReady });
});

app.get("/v1/info", (_req: Request, res: Response) => {
  res.json({
    version: "1.2.0",
    device: "cpu",
    device_name: "CPU",
    cuda: false,
    models_ready: modelsReady,
    detectors: DETECTORS,
    decoders: DECODERS,
    defaults: {
      detector: DEFAULT_DETECTOR,
      decoder: DEFAULT_DECODER,
      layout: true,
    },
    formats: Object.keys(FORMATS),
    limits: {
      max_upload_mb: MAX_UPLOAD_MB,
      max_pdf_pages: MAX_PDF_PAGES,
      job_ttl_hours: JOB_TTL_HOURS,
    },
    auth: Boolean(API_KEY),
  });
});

app.post("/v1/ocr", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(422).json({ detail: "No file uploaded." });
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      res.status(413).json({ detail: `File too large. The limit is ${MAX_UPLOAD_MB} MB.` });
      return;
    }

    const parseBool = (val: any, def: boolean) => {
      if (val === undefined || val === null || val === "") return def;
      return ["true", "1", "yes", "on"].includes(String(val).toLowerCase());
    };

    const detector = String(req.body?.detector || DEFAULT_DETECTOR);
    const decoder = String(req.body?.decoder || DEFAULT_DECODER) as "ar" | "blockwise";
    const layout = parseBool(req.body?.layout, true);
    const includeHeadersFooters = parseBool(req.body?.include_headers_footers, true);
    const wait = parseBool(req.body?.wait, true);
    const conf = req.body?.conf !== undefined && req.body?.conf !== "" ? Number(req.body.conf) : null;

    if (!DETECTORS.includes(detector)) {
      res.status(422).json({ detail: `Unknown detector '${detector}'. Use one of ${JSON.stringify(DETECTORS)}.` });
      return;
    }
    if (!DECODERS.includes(decoder)) {
      res.status(422).json({ detail: `Unknown decoder '${decoder}'. Use one of ${JSON.stringify(DECODERS)}.` });
      return;
    }

    const kind = sniffKind(file.buffer.subarray(0, 16));
    if (!kind) {
      res.status(415).json({ detail: "Unsupported file. Upload a PDF, JPG, PNG, TIFF, BMP or WebP." });
      return;
    }

    const id = crypto.randomBytes(16).toString("hex");
    const now = Date.now() / 1000;
    const options: ProcessOptions = {
      layout,
      detector,
      decoder,
      include_headers_footers: includeHeadersFooters,
      conf: detector === "yolo" ? conf : null,
    };

    const job: JobRecord = {
      id,
      filename: safeBasename(file.originalname),
      kind,
      options,
      status: "running",
      pages_done: 0,
      pages_total: 1,
      error: null,
      created: now,
      updated: now,
      edited: false,
    };

    jobs.set(id, job);
    writeJobMeta(job);

    const runPromise = (async () => {
      try {
        const d = jobDir(id);
        const doc = await processUploadedDocument(
          file.buffer,
          file.originalname || job.filename,
          kind,
          d,
          options,
          (done, total) => {
            job.pages_done = done;
            job.pages_total = total;
            writeJobMeta(job);
          }
        );
        saveDocFile(id, doc, "document.ocr.json");
        saveDocFile(id, doc, "document.json");
        job.status = "done";
        job.pages_done = job.pages_total;
        job.error = null;
        writeJobMeta(job);
      } catch (err: any) {
        job.status = "error";
        job.error = `${err?.name || "Error"}: ${err?.message || String(err)}`;
        writeJobMeta(job);
      }
    })();

    if (wait) {
      await Promise.race([
        runPromise,
        new Promise((resolve) => setTimeout(resolve, SYNC_TIMEOUT_MS)),
      ]);
      if (job.status === "done") {
        res.status(200).json({ job: jobPublic(job), document: loadDocFile(id) });
        return;
      }
      if (job.status === "error") {
        res.status(500).json({ job: jobPublic(job) });
        return;
      }
    }

    res.status(202).json({ job: jobPublic(job) });
  } catch (err: any) {
    res.status(500).json({ detail: err?.message || "Internal server error" });
  }
});

app.get("/v1/jobs", (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 50)));
  const sorted = [...jobs.values()].sort((a, b) => b.created - a.created).slice(0, limit);
  res.json({ jobs: sorted.map(jobPublic) });
});

app.get("/v1/jobs/:job_id", (req: Request, res: Response) => {
  const job = jobs.get(String(req.params.job_id));
  if (!job) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  res.json({ job: jobPublic(job) });
});

app.delete("/v1/jobs/:job_id", (req: Request, res: Response) => {
  const jobId = String(req.params.job_id);
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  jobs.delete(jobId);
  try {
    fs.rmSync(jobDir(jobId), { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
  res.status(204).end();
});

app.get("/v1/jobs/:job_id/document", (req: Request, res: Response) => {
  const jobId = String(req.params.job_id);
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  if (job.status !== "done") {
    res.status(409).json({ detail: `Document not ready (job is ${job.status}).` });
    return;
  }
  const original = ["true", "1"].includes(String(req.query.original || "").toLowerCase());
  const doc = loadDocFile(jobId, original);
  res.setHeader("ETag", `"${doc.revision}"`);
  res.json(doc);
});

app.put("/v1/jobs/:job_id/document", express.json({ limit: "15mb" }), (req: Request, res: Response) => {
  const jobId = String(req.params.job_id);
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  if (job.status !== "done") {
    res.status(409).json({ detail: `Document not ready (job is ${job.status}).` });
    return;
  }

  const current = loadDocFile(jobId, false);
  const ifMatch = (req.header("if-match") || "").trim().replace(/^"|"$/g, "");
  const rawExpected = ifMatch !== "" ? ifMatch : req.body?.revision;

  if (rawExpected !== undefined && rawExpected !== null && rawExpected !== "") {
    const expected = Number(rawExpected);
    if (!Number.isInteger(expected)) {
      res.status(400).json({ detail: "If-Match must be a document revision number." });
      return;
    }
    if (expected !== current.revision) {
      res.status(409).json({
        detail: "The document was changed elsewhere.",
        current,
      });
      return;
    }
  }

  try {
    const assetsDir = path.join(jobDir(jobId), "assets");
    const { pages, blocks } = validateDocumentInput(req.body, assetsDir);
    const updatedDoc: OcrDocument = {
      version: 1,
      revision: current.revision + 1,
      pages,
      blocks,
    };
    saveDocFile(jobId, updatedDoc, "document.json");
    job.edited = true;
    writeJobMeta(job);
    res.setHeader("ETag", `"${updatedDoc.revision}"`);
    res.json({ revision: updatedDoc.revision });
  } catch (err: any) {
    res.status(422).json({ detail: err?.message || "Invalid document structure." });
  }
});

app.post("/v1/jobs/:job_id/document/reset", (req: Request, res: Response) => {
  const jobId = String(req.params.job_id);
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  if (job.status !== "done") {
    res.status(409).json({ detail: `Document not ready (job is ${job.status}).` });
    return;
  }
  const current = loadDocFile(jobId, false);
  const original = loadDocFile(jobId, true);
  original.revision = current.revision + 1;
  saveDocFile(jobId, original, "document.json");
  job.edited = false;
  writeJobMeta(job);
  res.json(original);
});

app.get("/v1/jobs/:job_id/export", async (req: Request, res: Response) => {
  const jobId = String(req.params.job_id);
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  if (job.status !== "done") {
    res.status(409).json({ detail: `Document not ready (job is ${job.status}).` });
    return;
  }
  const fmt = String(req.query.format || "docx").toLowerCase();
  if (!FORMATS[fmt]) {
    res.status(422).json({ detail: `Unsupported format '${fmt}'.` });
    return;
  }
  try {
    const doc = loadDocFile(jobId, false);
    const assetsDir = path.join(jobDir(jobId), "assets");
    const { data, filename, mime } = await exportDocument(doc, fmt, job.filename, assetsDir);
    const ext = path.extname(filename);
    res.setHeader("Content-Type", mime);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="document${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.send(data);
  } catch (err: any) {
    res.status(500).json({ detail: err?.message || "Export failed." });
  }
});

app.get("/v1/jobs/:job_id/assets/:asset_id", (req: Request, res: Response) => {
  const jobId = String(req.params.job_id);
  const assetId = String(req.params.asset_id);
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  if (job.status !== "done") {
    res.status(409).json({ detail: `Document not ready (job is ${job.status}).` });
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(assetId)) {
    res.status(404).json({ detail: "Asset not found." });
    return;
  }
  const assetsDir = path.join(jobDir(jobId), "assets");
  for (const ext of [".png", ".jpg"]) {
    const p = path.join(assetsDir, assetId + ext);
    if (fs.existsSync(p)) {
      res.setHeader("Cache-Control", "private, max-age=86400, immutable");
      res.sendFile(p);
      return;
    }
  }
  res.status(404).json({ detail: "Asset not found." });
});

app.get("/docs", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Netra OCR — REST API Reference</title>
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/static/tokens.css">
  <link rel="stylesheet" href="/static/app.css">
</head>
<body>
  <header class="nav">
    <div class="nav-inner">
      <a class="brand" href="/" aria-label="Netra OCR">
        <span class="lockup" aria-hidden="true"></span>
      </a>
      <nav class="nav-links" aria-label="Main">
        <a href="/#/">Documents</a>
        <a href="/#/api">API</a>
        <a href="/docs" aria-current="page">OpenAPI Specs</a>
      </nav>
    </div>
  </header>
  <main class="wrap page">
    <header class="page-head">
      <p class="eyebrow muted2">Netra OCR v1.2.0</p>
      <h1 class="h1">REST API Reference</h1>
      <p class="lede muted">Khmer + English document OCR: layout analysis, text recognition, and structured export (DOCX, HTML, Markdown, JSON, TXT).</p>
    </header>
    <div>
      <div class="endpoint"><span class="verb">GET</span><div><code>/health</code><p class="meta muted" style="margin-top:6px">Health check and model readiness state.</p></div></div>
      <div class="endpoint"><span class="verb">GET</span><div><code>/v1/info</code><p class="meta muted" style="margin-top:6px">Server, model, detector/decoder defaults, and upload limits.</p></div></div>
      <div class="endpoint"><span class="verb">POST</span><div><code>/v1/ocr</code><p class="meta muted" style="margin-top:6px">Upload an image or PDF for OCR (multipart form fields: file, layout, detector, decoder, include_headers_footers, conf, wait).</p></div></div>
      <div class="endpoint"><span class="verb">GET</span><div><code>/v1/jobs</code><p class="meta muted" style="margin-top:6px">Recent OCR jobs, newest first.</p></div></div>
      <div class="endpoint"><span class="verb">GET</span><div><code>/v1/jobs/{job_id}</code><p class="meta muted" style="margin-top:6px">Job status and page progress.</p></div></div>
      <div class="endpoint"><span class="verb">DELETE</span><div><code>/v1/jobs/{job_id}</code><p class="meta muted" style="margin-top:6px">Delete a job and all its files.</p></div></div>
      <div class="endpoint"><span class="verb">GET</span><div><code>/v1/jobs/{job_id}/document</code><p class="meta muted" style="margin-top:6px">The structured document (with any saved edits; pass ?original=true for raw OCR result).</p></div></div>
      <div class="endpoint"><span class="verb">PUT</span><div><code>/v1/jobs/{job_id}/document</code><p class="meta muted" style="margin-top:6px">Save an edited document with optimistic concurrency via If-Match header.</p></div></div>
      <div class="endpoint"><span class="verb">POST</span><div><code>/v1/jobs/{job_id}/document/reset</code><p class="meta muted" style="margin-top:6px">Discard edits and restore the original OCR result.</p></div></div>
      <div class="endpoint"><span class="verb">GET</span><div><code>/v1/jobs/{job_id}/export?format=docx|html|md|json|txt</code><p class="meta muted" style="margin-top:6px">Export and download the structured document.</p></div></div>
      <div class="endpoint"><span class="verb">GET</span><div><code>/v1/jobs/{job_id}/assets/{asset_id}</code><p class="meta muted" style="margin-top:6px">Fetch a page render or figure/table crop image.</p></div></div>
    </div>
  </main>
</body>
</html>`);
});

const staticDir = path.resolve("static");
app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(staticDir, "index.html"));
});
app.use("/static", express.static(staticDir));

async function bootstrap() {
  loadExistingJobs();
  await seedSampleJobsIfEmpty();

  app.listen(PORT, HOST, () => {
    console.log(`Netra OCR server listening on http://${HOST}:${PORT}`);
  });

  // Warm up ONNX models in background
  if (process.env.NETRA_WARMUP !== "false") {
    Promise.all([getLineDetector(), getRecognizer(DEFAULT_DECODER)])
      .then(() => {
        modelsReady = true;
        console.log("Netra OCR ONNX models warmed up.");
      })
      .catch((err) => {
        modelsReady = true;
        console.warn("Background ONNX model warmup deferred to first upload:", err?.message || err);
      });
  }
}

bootstrap();
