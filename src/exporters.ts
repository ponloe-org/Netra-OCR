import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import {
  AlignmentType,
  BorderStyle,
  Document as WordDocument,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

export interface DocPage {
  index: number;
  width: number;
  height: number;
  image: string | null;
}

export interface DocLine {
  text: string;
  bbox: [number, number, number, number] | null;
}

export interface DocBlock {
  id: string;
  type: "heading" | "paragraph" | "caption" | "table" | "figure" | "formula" | "page_header" | "page_footer";
  page: number;
  bbox: [number, number, number, number] | null;
  label?: string;
  text?: string;
  align?: "left" | "center" | "right" | "justify";
  level?: 1 | 2 | 3;
  rows?: string[][];
  image?: string | null;
  caption?: string;
  lines?: DocLine[];
}

export interface OcrDocument {
  version: number;
  revision: number;
  pages: DocPage[];
  blocks: DocBlock[];
}

export const FORMATS: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
};

const TEXT_TYPES = new Set(["heading", "paragraph", "caption", "page_header", "page_footer"]);

export function getPlainText(doc: OcrDocument): string {
  const parts: string[] = [];
  for (const b of doc.blocks) {
    if (TEXT_TYPES.has(b.type) && b.text) {
      parts.push(b.text);
    } else if (b.type === "table" && b.rows) {
      parts.push(b.rows.map((r) => r.join("\t")).join("\n"));
    }
  }
  return parts.filter((p) => p.trim()).join("\n\n");
}

function readAssetBytes(assetsDir: string | null, assetId: string | null | undefined): Buffer | null {
  if (!assetsDir || !assetId || !/^[A-Za-z0-9_-]{1,64}$/.test(assetId)) return null;
  for (const ext of [".png", ".jpg"]) {
    const p = path.join(assetsDir, assetId + ext);
    if (fs.existsSync(p)) {
      return fs.readFileSync(p);
    }
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HTML_CSS = `
:root{--ground:#f6f2ec;--panel:#fff;--ink:#191014;--muted:#6b6266;--muted-2:#948b8f;
--border:#e7e1e0;--primary:#e75f1b;--maroon:#4f2724;--wash:rgba(79,39,36,.045);}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
font-family:"Kantumruy Pro","Noto Sans Khmer",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:46rem;margin:0 auto;padding:40px 24px 80px}
section.page{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:40px;margin-bottom:24px}
h1,h2,h3{font-weight:700;text-wrap:balance;margin:1.2em 0 .5em}
h1{font-size:28px;line-height:1.25;letter-spacing:-.01em}
h2{font-size:22px;line-height:1.3;color:var(--maroon)}
h3{font-size:18px;line-height:1.3;color:var(--maroon)}
p{font-size:17px;line-height:1.7;margin:0 0 1em;white-space:pre-wrap}
.caption,header p,footer p{font-size:13px;line-height:1.4;color:var(--muted)}
.caption{font-style:italic}
header,footer{border-color:var(--border);border-style:solid;border-width:0}
header{border-bottom-width:1px;margin-bottom:24px}
footer{border-top-width:1px;margin-top:24px;padding-top:8px}
figure{margin:1.2em 0;text-align:center}
figure img{max-width:100%;height:auto}
table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:15px;line-height:1.5}
th,td{border:1px solid var(--border);padding:8px 10px;text-align:left;vertical-align:top;white-space:pre-wrap}
th{background:var(--wash);font-weight:600}
.meta{font-size:13px;color:var(--muted-2);font-variant-numeric:tabular-nums}
`;

export function toHtml(doc: OcrDocument, assetsDir: string | null, title = "Netra OCR document"): Buffer {
  const byPage = new Map<number, DocBlock[]>();
  for (const b of doc.blocks) {
    const list = byPage.get(b.page) || [];
    list.push(b);
    byPage.set(b.page, list);
  }

  const renderBlock = (b: DocBlock): string => {
    const alignStyle = b.align && b.align !== "left" ? ` style="text-align:${b.align}"` : "";
    if (b.type === "heading") {
      const lvl = b.level || 1;
      return `<h${lvl}${alignStyle}>${escapeHtml(b.text || "")}</h${lvl}>`;
    }
    if (b.type === "paragraph" || b.type === "page_header" || b.type === "page_footer") {
      return `<p${alignStyle}>${escapeHtml(b.text || "")}</p>`;
    }
    if (b.type === "caption") {
      return `<p class="caption"${alignStyle}>${escapeHtml(b.text || "")}</p>`;
    }
    if (b.type === "figure" || b.type === "formula") {
      const bytes = readAssetBytes(assetsDir, b.image);
      if (!bytes) return "";
      const uri = `data:image/png;base64,${bytes.toString("base64")}`;
      return `<figure><img src="${uri}" alt=""></figure>`;
    }
    if (b.type === "table" && b.rows) {
      const rows = b.rows;
      const out = ["<table>"];
      if (b.caption) out.push(`<caption>${escapeHtml(b.caption)}</caption>`);
      rows.forEach((row, ri) => {
        const tag = ri === 0 && rows.length > 1 ? "th" : "td";
        out.push("<tr>" + row.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join("") + "</tr>");
      });
      out.push("</table>");
      if (rows.length === 1 && rows[0].length === 1 && b.image) {
        const bytes = readAssetBytes(assetsDir, b.image);
        if (bytes) {
          const uri = `data:image/png;base64,${bytes.toString("base64")}`;
          out.unshift(`<figure><img src="${uri}" alt=""></figure>`);
        }
      }
      return out.join("");
    }
    return "";
  };

  const sortedPages = [...byPage.keys()].sort((a, b) => a - b);
  const sections = sortedPages.map((pageIndex) => {
    const blocks = byPage.get(pageIndex) || [];
    const head = blocks.filter((b) => b.type === "page_header").map(renderBlock).join("");
    const body = blocks
      .filter((b) => b.type !== "page_header" && b.type !== "page_footer")
      .map(renderBlock)
      .join("");
    const foot = blocks.filter((b) => b.type === "page_footer").map(renderBlock).join("");
    return (
      `<section class="page" data-page="${pageIndex + 1}">` +
      (head ? `<header>${head}</header>` : "") +
      body +
      (foot ? `<footer>${foot}</footer>` : "") +
      `</section>`
    );
  });

  const html =
    `<!DOCTYPE html><html lang="km"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${HTML_CSS}</style></head>` +
    `<body><main>${sections.join("")}<p class="meta">Extracted with Netra OCR</p></main></body></html>`;
  return Buffer.from(html, "utf-8");
}

export async function toMarkdownBytes(doc: OcrDocument, assetsDir: string | null): Promise<{ data: Buffer; ext: string }> {
  const out: string[] = [];
  const images: Record<string, Buffer> = {};
  let prevPage: number | null = null;

  const escCell = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, "<br>");

  for (const b of doc.blocks) {
    if (prevPage !== null && b.page !== prevPage) {
      out.push("---");
    }
    prevPage = b.page;
    if (b.type === "heading") {
      out.push("#".repeat(b.level || 1) + " " + (b.text || "").replace(/\n/g, " — "));
    } else if (b.type === "paragraph" || b.type === "page_header" || b.type === "page_footer") {
      out.push((b.text || "").replace(/\n/g, "  \n"));
    } else if (b.type === "caption") {
      out.push(`*${b.text || ""}*`);
    } else if (b.type === "figure" || b.type === "formula") {
      const bytes = readAssetBytes(assetsDir, b.image);
      if (bytes && b.image) {
        const relPath = `images/${b.image}.png`;
        images[relPath] = bytes;
        out.push(`![](${relPath})`);
      }
    } else if (b.type === "table" && b.rows && b.rows.length) {
      const rows = b.rows;
      const ncols = Math.max(...rows.map((r) => r.length));
      const lines = [
        "| " + rows[0].map(escCell).join(" | ") + " |",
        "|" + " --- |".repeat(ncols),
        ...rows.slice(1).map((r) => "| " + r.map(escCell).join(" | ") + " |"),
      ];
      out.push(lines.join("\n"));
    }
  }

  const md = out.join("\n\n") + "\n";
  if (Object.keys(images).length === 0) {
    return { data: Buffer.from(md, "utf-8"), ext: ".md" };
  }
  const zip = new JSZip();
  zip.file("document.md", md);
  for (const [p, buf] of Object.entries(images)) {
    zip.file(p, buf);
  }
  const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { data: zipBuf, ext: ".zip" };
}

export async function toDocx(doc: OcrDocument, assetsDir: string | null): Promise<Buffer> {
  const mapAlign = (a?: string) => {
    if (a === "center") return AlignmentType.CENTER;
    if (a === "right") return AlignmentType.RIGHT;
    if (a === "justify") return AlignmentType.JUSTIFIED;
    return AlignmentType.LEFT;
  };

  const makeRuns = (text: string, opts: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}) => {
    const parts = (text || "").split("\n");
    return parts.map(
      (part, i) =>
        new TextRun({
          text: part,
          break: i > 0 ? 1 : undefined,
          font: "Kantumruy Pro",
          bold: opts.bold,
          italics: opts.italics,
          size: opts.size || 22,
          color: opts.color || "191014",
        })
    );
  };

  const children: (Paragraph | Table)[] = [];
  const pageMap = new Map<number, DocPage>();
  for (const p of doc.pages) pageMap.set(p.index, p);

  for (const b of doc.blocks) {
    if (b.type === "heading") {
      const level = b.level || 1;
      const size = level === 1 ? 36 : level === 2 ? 28 : 24;
      const color = level === 1 ? "191014" : "4F2724";
      children.push(
        new Paragraph({
          heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          alignment: mapAlign(b.align),
          spacing: { before: 240, after: 120 },
          children: makeRuns(b.text || "", { bold: true, size, color }),
        })
      );
    } else if (b.type === "paragraph" || b.type === "page_header" || b.type === "page_footer") {
      const isMargin = b.type === "page_header" || b.type === "page_footer";
      children.push(
        new Paragraph({
          alignment: mapAlign(b.align),
          spacing: { after: 120 },
          children: makeRuns(b.text || "", {
            size: isMargin ? 18 : 22,
            color: isMargin ? "6B6266" : "191014",
          }),
        })
      );
    } else if (b.type === "caption") {
      children.push(
        new Paragraph({
          alignment: mapAlign(b.align),
          spacing: { after: 120 },
          children: makeRuns(b.text || "", { italics: true, size: 19, color: "6B6266" }),
        })
      );
    } else if (b.type === "figure" || b.type === "formula") {
      const bytes = readAssetBytes(assetsDir, b.image);
      if (bytes) {
        const pageW = pageMap.get(b.page)?.width || 800;
        const bw = b.bbox ? Math.max(40, b.bbox[2] - b.bbox[0]) : 300;
        const bh = b.bbox ? Math.max(40, b.bbox[3] - b.bbox[1]) : 200;
        const frac = Math.max(0.08, Math.min(1.0, bw / pageW));
        const targetW = Math.round(550 * frac);
        const targetH = Math.round(targetW * (bh / bw));
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 120 },
            children: [
              new ImageRun({
                data: bytes,
                transformation: { width: targetW, height: targetH },
                type: "png",
              }),
            ],
          })
        );
      }
    } else if (b.type === "table" && b.rows && b.rows.length) {
      const rows = b.rows;
      const ncols = Math.max(...rows.map((r) => r.length));
      const border = { style: BorderStyle.SINGLE, size: 4, color: "E7E1E0" };
      const table = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: rows.map((row, ri) => {
          const isHeader = ri === 0 && rows.length > 1;
          return new TableRow({
            children: Array.from({ length: ncols }, (_, ci) => {
              return new TableCell({
                borders: { top: border, bottom: border, left: border, right: border },
                shading: isHeader ? { fill: "F7F5F5", type: ShadingType.CLEAR, color: "auto" } : undefined,
                children: [
                  new Paragraph({
                    children: makeRuns(row[ci] || "", { bold: isHeader, size: 20 }),
                  }),
                ],
              });
            }),
          });
        }),
      });
      children.push(table);
    }
  }

  const wordDoc = new WordDocument({
    sections: [{ children }],
  });
  return await Packer.toBuffer(wordDoc);
}

export async function exportDocument(
  doc: OcrDocument,
  fmt: string,
  basename = "document",
  assetsDir: string | null = null
): Promise<{ data: Buffer; filename: string; mime: string }> {
  const cleanFmt = fmt.toLowerCase().replace(/^\./, "");
  if (cleanFmt === "docx") {
    const data = await toDocx(doc, assetsDir);
    return { data, filename: `${basename}.docx`, mime: FORMATS.docx };
  }
  if (cleanFmt === "html") {
    const data = toHtml(doc, assetsDir, basename);
    return { data, filename: `${basename}.html`, mime: FORMATS.html };
  }
  if (cleanFmt === "md") {
    const { data, ext } = await toMarkdownBytes(doc, assetsDir);
    return { data, filename: `${basename}${ext}`, mime: ext === ".md" ? FORMATS.md : "application/zip" };
  }
  if (cleanFmt === "json") {
    const data = Buffer.from(JSON.stringify(doc, null, 2), "utf-8");
    return { data, filename: `${basename}.json`, mime: FORMATS.json };
  }
  if (cleanFmt === "txt") {
    const data = Buffer.from(getPlainText(doc), "utf-8");
    return { data, filename: `${basename}.txt`, mime: FORMATS.txt };
  }
  throw new Error(`Unsupported format '${fmt}'. Supported: ${Object.keys(FORMATS).join(", ")}`);
}
