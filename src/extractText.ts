import { PDFParse } from "pdf-parse";

const MAX_CHARS = 80_000;

export class ExtractTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractTextError";
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string): string {
  const trimmed = text.replace(/\u0000/g, "").trim();
  if (trimmed.length <= MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_CHARS)}\n\n[…truncated for AI context limit…]`;
}

/** Extract plain text from common document uploads. */
export async function extractTextFromUpload(params: {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<string> {
  const name = params.filename.toLowerCase();
  const mime = (params.mimeType || "").toLowerCase();

  const isPdf = mime.includes("pdf") || name.endsWith(".pdf");
  const isText =
    mime.startsWith("text/") ||
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".csv") ||
    name.endsWith(".tsv") ||
    name.endsWith(".log");
  const isHtml =
    mime.includes("html") || name.endsWith(".html") || name.endsWith(".htm");
  const isJson = mime.includes("json") || name.endsWith(".json");

  if (isPdf) {
    const parser = new PDFParse({ data: params.buffer });
    const result = await parser.getText();
    const text = truncate(String(result.text ?? ""));
    if (!text) {
      throw new ExtractTextError(
        "Could not extract text from that PDF (it may be image-only)."
      );
    }
    return text;
  }

  if (isHtml) {
    const text = truncate(stripHtml(params.buffer.toString("utf8")));
    if (!text) throw new ExtractTextError("HTML file had no readable text.");
    return text;
  }

  if (isText || isJson) {
    const text = truncate(params.buffer.toString("utf8"));
    if (!text) throw new ExtractTextError("File was empty.");
    return text;
  }

  throw new ExtractTextError(
    "Unsupported file type. Upload PDF, TXT, MD, CSV, HTML, or JSON."
  );
}
