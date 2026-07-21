import assert from "node:assert/strict";
import { extractTextFromUpload } from "./extractText.js";

const text = await extractTextFromUpload({
  filename: "notes.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("Mayor Reyes opened the hearing on harbor slips."),
});
assert.match(text, /Mayor Reyes/);

const html = await extractTextFromUpload({
  filename: "agenda.html",
  mimeType: "text/html",
  buffer: Buffer.from("<h1>Agenda</h1><p>Dock vote 4-3</p>"),
});
assert.match(html, /Dock vote/);
assert.doesNotMatch(html, /<h1>/);

let failed = false;
try {
  await extractTextFromUpload({
    filename: "photo.png",
    mimeType: "image/png",
    buffer: Buffer.from([1, 2, 3]),
  });
} catch {
  failed = true;
}
assert.equal(failed, true);

console.log("extractText.smoke ok");
