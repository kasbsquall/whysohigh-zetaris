// Web server for Why So High: GET /api/demo runs Linda's demo through the same
// agent pipeline as the CLI, POST /api/run runs one request (input_examples/),
// POST /api/photo reads a bill photo with BillReader and explains it (GET says
// whether this copy can), GET /api/events streams each SQL statement of a photo or of the demo
// to the page while it is read, and the built page is served from web/dist.
//   npm run serve            (after npm run web:build)
// Binds to 127.0.0.1 unless HOST says otherwise. Without .env it runs in SAMPLE_MODE.

import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { readBillPhoto, SAMPLE_PHOTO } from "../src/billPhoto.ts";
import { SampleMissError } from "../src/cache.ts";
import { demoPayload, runLindaDemo, type DemoPayload } from "../src/demo.ts";
import { InputError, parseRunInput } from "../src/input.ts";
import { onLogEvent } from "../src/log.ts";
import { runRequest } from "../src/runRequest.ts";
import { createRuntime } from "../src/runtime.ts";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8787);
const DIST = resolve("web", "dist");

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

/** The demo runs once per server process; every request reads the same result. */
let demo: Promise<DemoPayload> | null = null;
// While the demo runs, /api/events?for=demo streams its statements.
let demoRunning = false;
const SAMPLE_PHOTO_MESSAGE =
  "Reading a new photo needs the live models. This copy of the page replays recorded runs, so it can show the sample photo but cannot read a new one. To read your own bill, run Why So High with its models (README, Run it live).";

const loadDemo = (): Promise<DemoPayload> => {
  if (!demo) demoRunning = true;
  demo ??= runLindaDemo(join(mkdtempSync(join(tmpdir(), "wsh-web-")), "memory"))
    .then(demoPayload)
    .catch((error: unknown) => {
      demo = null;
      throw error;
    })
    .finally(() => {
      demoRunning = false;
    });
  return demo;
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store" });
  res.end(body);
}

function serveStatic(path: string, res: ServerResponse): void {
  const file = normalize(join(DIST, path === "/" ? "index.html" : path));
  if (!file.startsWith(DIST + sep) || !existsSync(file) || !statSync(file).isFile()) {
    send(res, 404, "text/plain; charset=utf-8", "Not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff" });
  createReadStream(file)
    .on("error", (error) => {
      process.stderr.write(`Could not read ${file}: ${error.message}
`);
      res.destroy();
    })
    .pipe(res);
}

/** The request path, or null when the URL cannot be parsed (for example "//" or "http://["). */
function pathOf(url: string | undefined): string | null {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

const MAX_BODY_BYTES = 256 * 1024;
const JSON_TYPE = "application/json; charset=utf-8";

/**
 * Reads a JSON body up to MAX_BODY_BYTES. Resolves to null when it is too large
 * (the rest is drained, not read, so the 413 still reaches the caller) or when
 * the client goes away before the end.
 */
function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = Number(req.headers["content-length"] ?? 0) > maxBytes;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("close", () => resolve(null));
    req.on("error", () => resolve(null));
  });
}

const failure = (type: string, message: string): string => JSON.stringify({ status: "error", error: { type, message } });

/** POST /api/run: one request (see input_examples/), one structured result, one trace in logs/. */
async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // JSON only: a browser cannot send this content type cross-site without a preflight.
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    req.resume();
    send(res, 415, JSON_TYPE, failure("UnsupportedMediaType", "Send the request with Content-Type: application/json."));
    return;
  }
  const body = await readBody(req);
  if (body === null) {
    send(res, 413, JSON_TYPE, failure("TooLarge", `The request is over ${MAX_BODY_BYTES / 1024} KB.`));
    return;
  }
  let input;
  try {
    const raw: unknown = JSON.parse(body);
    if (raw && typeof raw === "object" && "bill" in raw && (raw as { bill?: { image?: unknown } }).bill?.image !== undefined) {
      throw new InputError("The API takes bill.fields. To read a bill image, run the CLI with --bill and the live stack.");
    }
    input = parseRunInput(raw);
  } catch (error: unknown) {
    const message = error instanceof SyntaxError ? "The body is not valid JSON." : (error as Error).message;
    send(res, 400, JSON_TYPE, failure("InvalidInput", message));
    return;
  }
  const result = await runRequest(createRuntime(), input, null);
  if (result.status === "success") {
    send(res, 200, JSON_TYPE, JSON.stringify(result));
  } else if (result.error.type === "InvalidInput") {
    send(res, 400, JSON_TYPE, JSON.stringify(result));
  } else {
    // The reason stays in the trace; the caller gets where to find it.
    send(res, 500, JSON_TYPE, JSON.stringify({ ...result, error: { type: result.error.type, message: `The agents could not finish this run. The reason is in ${result.log_file}.` } }));
  }
}

// The page shrinks a photo to 1,600 px JPEG before sending, which stays well under this.
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const PHOTO = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/;
const MAGIC: Readonly<Record<string, readonly number[]>> = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47] };
// One photo at a time: each one is a vision model call and a full run.
let photoBusy = false;
// The run ids of the photos being read; /api/events streams only their statements.
const photoRuns = new Set<string>();

/** POST /api/photo: { "image": "data:image/jpeg;base64,..." }. Same result shape as /api/run. */
async function handlePhoto(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    req.resume();
    send(res, 415, JSON_TYPE, failure("UnsupportedMediaType", "Send the photo as JSON."));
    return;
  }
  const runtime = createRuntime();
  if (photoBusy) {
    req.resume();
    send(res, 429, JSON_TYPE, failure("Busy", "Another photo is being read. Try again in a minute."));
    return;
  }
  const body = await readBody(req, MAX_PHOTO_BYTES);
  if (body === null) {
    send(res, 413, JSON_TYPE, failure("TooLarge", "The photo is too large. Try a smaller one."));
    return;
  }
  let raw: { image?: unknown; sample?: unknown } = {};
  try {
    raw = JSON.parse(body) as { image?: unknown; sample?: unknown };
  } catch {
    raw = {};
  }
  // The sample photo is read from disk, so sample mode can replay its recorded run.
  const isSample = raw.sample === true;
  if (!isSample && runtime.config.sampleMode) {
    send(res, 503, JSON_TYPE, failure("SampleMode", SAMPLE_PHOTO_MESSAGE));
    return;
  }
  const match = !isSample && typeof raw.image === "string" ? PHOTO.exec(raw.image) : null;
  const bytes = isSample ? readFileSync(SAMPLE_PHOTO) : match ? Buffer.from(match[2], "base64") : null;
  const kind = isSample ? "jpeg" : match?.[1];
  if (!bytes || !kind || !MAGIC[kind].every((b, i) => bytes[i] === b)) {
    send(res, 400, JSON_TYPE, failure("InvalidInput", "That file is not a JPG or PNG photo."));
    return;
  }
  photoBusy = true;
  photoRuns.add(runtime.logger.runId);
  try {
    const result = await readBillPhoto(runtime, bytes, kind as "jpeg" | "png");
    if (result.status === "success") send(res, 200, JSON_TYPE, JSON.stringify(result));
    else send(res, 422, JSON_TYPE, JSON.stringify({ ...result, error: { type: result.error.type, message: "We could not read that bill. A sharp, flat photo of the first page works best." } }));
  } catch (error: unknown) {
    if (!(error instanceof SampleMissError)) throw error;
    send(res, 503, JSON_TYPE, failure("SampleMode", SAMPLE_PHOTO_MESSAGE));
  } finally {
    photoBusy = false;
    photoRuns.delete(runtime.logger.runId);
  }
}

// What the page shows of each statement while a run is going; nothing else of the log leaves the server.
const STREAM_FIELDS = ["ts", "runId", "agent", "step", "source", "zetarisQueryId", "sql", "rowCount", "latencyMs", "failedQueryId", "waitMs", "reason"] as const;
const STREAM_STEPS: ReadonlySet<string> = new Set(["sql", "sql_retry", "context_unavailable"]);
const PING_MS = 15_000;

/**
 * GET /api/events?for=photo|demo: every SQL statement that a photo's run, or the demo
 * while it runs, sends to Zetaris from now on, and any source the run has to go on
 * without, as server-sent events.
 */
function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  const forDemo = new URL(req.url ?? "/", "http://localhost").searchParams.get("for") === "demo";
  const wanted = (runId: string): boolean => (forDemo ? demoRunning && !photoRuns.has(runId) : photoRuns.has(runId));
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.write(": open\n\n");
  const stop = onLogEvent((record) => {
    if (!STREAM_STEPS.has(String(record.step)) || !wanted(String(record.runId)) || res.writableEnded) return;
    const picked = Object.fromEntries(STREAM_FIELDS.filter((k) => record[k] !== undefined).map((k) => [k, record[k]]));
    res.write(`data: ${JSON.stringify(picked)}\n\n`);
  });
  const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
  req.on("close", () => {
    stop();
    clearInterval(ping);
  });
}

const server = createServer((req, res) => {
  const path = pathOf(req.url);
  if (path === null) {
    send(res, 400, "text/plain; charset=utf-8", "Bad request");
    return;
  }
  if (path === "/api/run") {
    if (req.method !== "POST") {
      send(res, 405, JSON_TYPE, JSON.stringify({ status: "error", error: { type: "MethodNotAllowed", message: "Use POST with a JSON body." } }));
      return;
    }
    handleRun(req, res).catch((error: unknown) => {
      process.stderr.write(`Run failed: ${(error as Error).message}\n`);
      send(res, 500, JSON_TYPE, JSON.stringify({ status: "error", error: { type: "Error", message: "The run could not finish." } }));
    });
    return;
  }
  if (path === "/api/photo") {
    if (req.method === "GET") {
      // Lets the page say before the first click whether this copy can read a photo.
      const available = !createRuntime().config.sampleMode;
      send(res, 200, JSON_TYPE, JSON.stringify({ available, message: available ? null : SAMPLE_PHOTO_MESSAGE }));
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, JSON_TYPE, failure("MethodNotAllowed", "Use POST with a JSON body."));
      return;
    }
    handlePhoto(req, res).catch((error: unknown) => {
      process.stderr.write(`Photo failed: ${(error as Error).message}\n`);
      send(res, 500, JSON_TYPE, failure("Error", "The photo could not be read."));
    });
    return;
  }
  if (req.method !== "GET") {
    send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
    return;
  }
  if (path === "/api/events") {
    handleEvents(req, res);
    return;
  }
  if (path === "/api/demo") {
    loadDemo().then(
      (payload) => send(res, 200, "application/json; charset=utf-8", JSON.stringify(payload)),
      (error: unknown) => {
        process.stderr.write(`Demo failed: ${(error as Error).message}\n`);
        send(res, 500, "application/json; charset=utf-8", JSON.stringify({ error: "The agents could not finish this run. Please try again in a minute." }));
      },
    );
    return;
  }
  serveStatic(path, res);
});

server.listen(PORT, HOST, () => process.stdout.write(`Why So High on http://${HOST}:${PORT}\n`));
