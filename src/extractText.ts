import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export class ExtractTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractTextError";
  }
}

export const SUPPORTED_UPLOAD_FORMATS =
  "PDF, DOCX, TXT, MD, CSV, HTML, or JSON";

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

function cleanText(text: string): string {
  return text.replace(/\u0000/g, "").trim();
}

function enforceMaxChars(text: string, maxChars?: number): string {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text;
  throw new ExtractTextError(
    `Extracted text is too large (${text.length.toLocaleString()} characters; max ${maxChars.toLocaleString()}). Split the file or raise CONTEXT_UPLOAD_MAX_CHARS.`
  );
}

/** Extract plain text from common document uploads. */
export async function extractTextFromUpload(params: {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  /** Soft cap on extracted characters (memory safety). */
  maxChars?: number;
}): Promise<string> {
  const name = params.filename.toLowerCase();
  const mime = (params.mimeType || "").toLowerCase();

  const isPdf = mime.includes("pdf") || name.endsWith(".pdf");
  const isDocx =
    name.endsWith(".docx") ||
    mime.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) ||
    mime === "application/docx";
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
    const text = cleanText(String(result.text ?? ""));
    if (!text) {
      throw new ExtractTextError(
        "Could not extract text from that PDF (it may be image-only)."
      );
    }
    return enforceMaxChars(text, params.maxChars);
  }

  if (isDocx) {
    const result = await mammoth.extractRawText({ buffer: params.buffer });
    const text = cleanText(String(result.value ?? ""));
    if (!text) {
      throw new ExtractTextError(
        "Could not extract text from that Word document."
      );
    }
    return enforceMaxChars(text, params.maxChars);
  }

  if (isHtml) {
    const text = cleanText(stripHtml(params.buffer.toString("utf8")));
    if (!text) throw new ExtractTextError("HTML file had no readable text.");
    return enforceMaxChars(text, params.maxChars);
  }

  if (isText || isJson) {
    const text = cleanText(params.buffer.toString("utf8"));
    if (!text) throw new ExtractTextError("File was empty.");
    return enforceMaxChars(text, params.maxChars);
  }

  throw new ExtractTextError(
    `Unsupported file type. Upload ${SUPPORTED_UPLOAD_FORMATS}.`
  );
}
