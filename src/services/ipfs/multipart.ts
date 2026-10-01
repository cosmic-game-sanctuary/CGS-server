import { randomUUID } from "node:crypto";
import https from "node:https";
import type { Readable } from "node:stream";

export type MultipartField = { name: string; value: string };
export type MultipartFilePart = {
  name: string;
  filename: string;
  contentType: string;
  size: number;
  open: () => Readable;
};

export type MultipartResponse = { status: number; text: string };

/**
 * A multipart/form-data POST whose body is streamed straight from each file
 * part's source stream — never buffered whole in memory first.
 *
 * This exists because `fetch()` with a `FormData` body isn't actually a
 * streaming upload in Node: measured directly (scripts/bench-publish-memory.ts),
 * wrapping an 85MB buffer in a `File` and posting it via `fetch` cost another
 * ~230MB of RSS on top of the buffer itself, before any of our own code ran.
 * Pinata's SDK is built on exactly that path, which is why going around it —
 * not just avoiding our own copies — is what keeps a publish under a 512MB
 * instance's limit. Every file size is known upfront (multer and `fs.stat`
 * both give us real sizes before this runs), so Content-Length is computed
 * exactly and the request never needs chunked transfer encoding.
 */
export async function postMultipart(
  url: string,
  headers: Record<string, string>,
  fields: MultipartField[],
  files: MultipartFilePart[],
): Promise<MultipartResponse> {
  const boundary = `cgsBoundary${randomUUID().replace(/-/g, "")}`;
  const CRLF = "\r\n";

  const fieldHeader = (name: string) => Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`, "utf8");
  const fileHeader = (f: MultipartFilePart) =>
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${f.name}"; filename="${escapeHeaderValue(f.filename)}"${CRLF}Content-Type: ${f.contentType}${CRLF}${CRLF}`,
      "utf8",
    );
  const partFooter = Buffer.from(CRLF, "utf8");
  const closing = Buffer.from(`--${boundary}--${CRLF}`, "utf8");

  const fieldParts = fields.map((f) => ({ header: fieldHeader(f.name), body: Buffer.from(f.value, "utf8") }));
  const fileHeaders = files.map(fileHeader);

  let contentLength = closing.length;
  for (const f of fieldParts) contentLength += f.header.length + f.body.length + partFooter.length;
  for (const [i, f] of files.entries()) contentLength += fileHeaders[i]!.length + f.size + partFooter.length;

  return new Promise<MultipartResponse>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": contentLength },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);

    (async () => {
      for (const f of fieldParts) {
        request.write(f.header);
        request.write(f.body);
        request.write(partFooter);
      }
      for (const [i, f] of files.entries()) {
        request.write(fileHeaders[i]!);
        await pumpInto(f.open(), request);
        request.write(partFooter);
      }
      request.end(closing);
    })().catch(reject);
  });
}

// Deliberately not `pipeline()`: pipeline ends its destination when the
// source ends, and this destination (the HTTP request) has to stay open
// across every file part plus the closing boundary written after.
function pumpInto(readable: Readable, writable: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    readable.on("error", reject);
    readable.on("data", (chunk: Buffer) => {
      if (!writable.write(chunk)) {
        readable.pause();
        writable.once("drain", () => readable.resume());
      }
    });
    readable.on("end", resolve);
  });
}

function escapeHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
