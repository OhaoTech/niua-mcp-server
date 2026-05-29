#!/usr/bin/env node
/**
 * NIUA MCP Server (v0.5.0)
 *
 * Tools, Resources, and Prompts for generating game assets via NIUA from
 * Claude Desktop, Cursor, Cline, and any other MCP-compatible client.
 *
 * 0.5.0 (2026-05-25) — quality pass against the 2026 MCP best-practice
 * standards (see blog.modelcontextprotocol.io/posts/2026-mcp-roadmap and
 * arcade.dev/blog/mcp-tool-patterns). Concretely:
 *
 *  - registerTool / registerResource / registerPrompt — the modern SDK
 *    surface, with title + annotations on every tool so MCP clients can
 *    render confirm prompts intelligently (readOnlyHint, openWorldHint,
 *    destructiveHint).
 *
 *  - Tool responses use `isError: true` on failure so clients distinguish
 *    "tool ran and returned an error message" from "tool ran successfully
 *    and the result happens to mention an error word." This is the
 *    spec-mandated way; the old style was a violation that some clients
 *    silently accepted.
 *
 *  - Strict input validation. Every numeric param has .min/.max bounds
 *    matching the OpenAPI contract — a bad value is caught at the MCP
 *    layer instead of round-tripping to the gateway for a 400.
 *
 *  - Gateway error envelopes are parsed: `{error: {code, message,
 *    doc_url}}` becomes "[code] message (see doc_url)" instead of a raw
 *    body slice. Agents can now reason about error categories.
 *
 *  - Structured stderr logging on every tool call. The format is
 *    grep-able: `[niua-mcp] event=tool_call tool=generate_image …`.
 *    Visible in MCP Inspector and host-client logs.
 *
 *  - Progress notifications during long-running calls (mesh, rig,
 *    texture). When the client passes a progressToken in _meta the
 *    server sends a `notifications/progress` every 30s with elapsed
 *    time so the agent UI can show "still working" instead of opaque
 *    multi-minute silence.
 *
 *  - Resources: niua://docs/quickstart, niua://pricing/live,
 *    niua://models/catalog. Agents can read them via the standard
 *    resources/read flow without invoking a tool.
 *
 *  - Prompts: prop_brief, character_brief, music_brief, motion_brief.
 *    Canned "structured brief" templates that walk the user through
 *    composing a good generation prompt for each modality.
 *
 *  - Typed API response shapes (no more `: any`). Drift between the
 *    gateway and this server gets caught at build time.
 *
 *  - Uploads use the presigned-R2 flow from 0.4.0.
 *
 * Auth: `Authorization: Bearer` with a NIUA API key (env NIUA_API_KEY,
 * or run `niua-mcp --login` for browser-based device-auth).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { execFile } from "node:child_process";

// ── Config ──────────────────────────────────────────────────────────────────

const API_URL = process.env.NIUA_API_URL || "https://api.niua.ohao.tech";
const WEB_URL = "https://niua.ohao.tech";
const CRED_PATH = path.join(os.homedir(), ".niua", "credentials.json");
const SERVER_VERSION = "0.7.0";

// Long-running generations need a fetch timeout big enough to outlast
// the gateway. Mesh is the canonical outlier at ~6 min sync; rig can
// stretch to ~10 min cold. 15 min upper bound for the long tools;
// shorter ones use Node's no-timeout default.
const LONG_TIMEOUT_MS = 15 * 60 * 1000;
const PROGRESS_HEARTBEAT_MS = 30_000;

// ── Typed API response shapes ───────────────────────────────────────────────
//
// Every shape here mirrors a schema in
// niua-core/.../openapi/components/schemas/. Build-time check: tsc fails
// if a tool reaches into a field that isn't declared here, which catches
// drift between the gateway and this server.

interface GatewayErrorBody {
  code: string;
  message: string;
  doc_url?: string;
}

interface GatewayErrorEnvelope {
  error: GatewayErrorBody;
  [k: string]: unknown; // extras (price_cents, valid_models, …)
}

interface GenerateCompletedResponse {
  status: "completed";
  job_id: string;
  url: string;
  r2_key: string;
  metadata?: Record<string, unknown>;
}

interface GenerateProcessingResponse {
  status: "processing";
  job_id: string;
  metadata?: Record<string, unknown>;
}

/** Structured error envelope the gateway returns alongside status:"failed".
 *  Mirrors `niua-gateway/src/http/routes/v1/errors.rs::ApiError`. The
 *  `error` field can be a bare string (legacy) or this envelope shape;
 *  formatGenerateError() handles both. */
interface ErrorEnvelope {
  code?: string;
  message?: string;
  doc_url?: string;
  job_id?: string;
}

interface GenerateFailedResponse {
  status: "failed";
  job_id?: string;
  /** Legacy string OR structured ErrorEnvelope. */
  error?: string | ErrorEnvelope;
  message?: string;
}

/** Pull a human-readable message out of a failed-generation response.
 *  The gateway has used three shapes over time:
 *    - { error: "string" }
 *    - { error: { code, message, doc_url, job_id } }
 *    - { message: "string" }
 *  Past MCP versions printed the second shape as "[object Object]"
 *  because they string-interpolated the whole object. This extracts
 *  the right message regardless of shape and tacks on the doc URL when
 *  the structured envelope provides one. */
/** Shape of "something that could carry an error message." Accepts any
 *  of the GenerateResponse union members (Processing / Failed / Completed)
 *  plus a few legacy shapes — so callers can pass whatever they have
 *  without TypeScript fighting them on the union narrowing. */
type ErrorishResult = {
  status?: string;
  error?: string | ErrorEnvelope;
  message?: string;
};

function formatGenerateError(result: ErrorishResult): string {
  // Structured envelope wins
  if (result.error && typeof result.error === "object") {
    const env = result.error;
    const code = env.code ? `[${env.code}] ` : "";
    const docHint = env.doc_url ? ` (see ${env.doc_url})` : "";
    const msg = env.message ?? "unknown error";
    return `${code}${msg}${docHint}`;
  }
  // Legacy string error or top-level message field
  return (
    (typeof result.error === "string" && result.error) ||
    result.message ||
    "unknown error"
  );
}

type GenerateResponse =
  | GenerateCompletedResponse
  | GenerateProcessingResponse
  | GenerateFailedResponse;

interface JobResponse {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed" | string;
  output_key?: string;
  url?: string;
  gpu_seconds?: number;
  error?: string;
  pipeline?: string;
  filename?: string;
}

interface WalletStatus {
  wallet_cents: number;
  wallet_display?: string;
}

interface PriceEntry {
  service: string;
  price_cents: number;
  price_display?: string;
}

interface PresignResponse {
  asset_id: string;
  upload_url: string;
  expires_at: string;
  r2_key: string;
  max_size_bytes: number;
}

interface FinalizeResponse {
  asset_id: string;
  r2_key: string;
  asset_type: string;
  url: string;
}

interface DeviceAuthStartResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
}

interface DeviceAuthPollResponse {
  api_key?: string;
  error?: string;
}

// ── Credentials ─────────────────────────────────────────────────────────────

function loadApiKey(): string {
  if (process.env.NIUA_API_KEY) return process.env.NIUA_API_KEY;
  try {
    if (fs.existsSync(CRED_PATH)) {
      const cred = JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
      if (cred.api_key) return cred.api_key;
    }
  } catch {
    // Silently ignore corrupted credentials; the user will get a clear
    // "not authenticated" error when they try a tool.
  }
  return "";
}

function saveApiKey(key: string) {
  const dir = path.dirname(CRED_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CRED_PATH, JSON.stringify({ api_key: key }, null, 2));
  try { fs.chmodSync(CRED_PATH, 0o600); } catch { /* Windows — no-op */ }
}

function openInBrowser(url: string): void {
  // node:child_process is imported statically at the top of the file.
  // 0.5.0 lazy-loaded it via require() to avoid pulling it into the
  // test-import path, but require is undefined in ESM (the package's
  // "type": "module") and the call crashed deviceLogin before the
  // polling loop. Static import is the right move: child_process is
  // a Node built-in, zero cost, and we don't ship tests yet.
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  execFile(cmd as string, args as string[], () => { /* fire and forget */ });
}

// ── Device login (--login flag) ─────────────────────────────────────────────

async function deviceLogin(): Promise<never> {
  console.log("NIUA Device Login\n");

  const resp = await fetch(`${API_URL}/api/auth/device`, { method: "POST" });
  if (!resp.ok) {
    console.error(`Failed to start device auth: ${resp.status}`);
    process.exit(1);
  }
  const { device_code, user_code, verification_url } =
    (await resp.json()) as DeviceAuthStartResponse;

  console.log(`Verification code: ${user_code}\n`);
  console.log(`Opening browser… If it doesn't open, go to:`);
  const fullUrl = `${verification_url}?code=${user_code}&device_code=${device_code}`;
  console.log(`  ${fullUrl}\n`);

  openInBrowser(fullUrl);

  console.log("Waiting for approval…");
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const tokenResp = await fetch(`${API_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code }),
    });
    const result = (await tokenResp.json()) as DeviceAuthPollResponse;

    if (result.api_key) {
      saveApiKey(result.api_key);
      console.log(`\nAuthenticated. API key saved to ${CRED_PATH}.`);
      process.exit(0);
    }
    if (result.error === "expired") {
      console.log("\nDevice code expired. Try again.");
      process.exit(1);
    }
    process.stdout.write(".");
  }

  console.log("\nTimeout. Try again.");
  process.exit(1);
}

if (process.argv.includes("--login")) {
  deviceLogin();
} else {

// ── Normal MCP server mode ──────────────────────────────────────────────────

const API_KEY = loadApiKey();

// ── Structured logging ──────────────────────────────────────────────────────
//
// Writes to stderr (stdio MCP transport owns stdout). Grep-able key=value
// format, JSON-quoted values. Visible in MCP Inspector and host-client
// logs. Per 2026 best-practice "observability must be designed in from
// the beginning."

function log(event: string, data: Record<string, unknown> = {}): void {
  const parts: string[] = [`[niua-mcp]`, `event=${event}`];
  for (const [k, v] of Object.entries(data)) {
    const formatted = typeof v === "string" ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${formatted}`);
  }
  console.error(parts.join(" "));
}

// ── Error parsing ───────────────────────────────────────────────────────────
//
// Gateway responses come back as `{error: {code, message, doc_url}, ...}`
// (see openapi/components/schemas/errors.yaml). Plain string slicing
// hides the structured info, so parse the envelope and present a clean
// "[code] message (doc_url)" line. Agents can read the code class and
// react (e.g. on `insufficient_funds`, tell the user to top up).

function parseGatewayError(httpStatus: number, body: string): string {
  try {
    const env = JSON.parse(body) as GatewayErrorEnvelope;
    if (env?.error?.code && env?.error?.message) {
      const docHint = env.error.doc_url ? ` (see ${env.error.doc_url})` : "";
      return `[${env.error.code}] ${env.error.message}${docHint}`;
    }
  } catch {
    /* not JSON */
  }
  return `HTTP ${httpStatus}: ${body.slice(0, 300)}`;
}

// ── Tool result helpers ─────────────────────────────────────────────────────

type TextContent = { type: "text"; text: string };
type ResourceContent = {
  type: "resource";
  resource: { uri: string; mimeType: string; text: string };
};
type ContentBlock = TextContent | ResourceContent;

interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  // Index signature satisfies the SDK's CallToolResult shape, which
  // allows arbitrary string keys (e.g. structuredContent, _meta).
  [k: string]: unknown;
}

function toolOk(content: ContentBlock[]): ToolResult {
  return { content };
}

/** Mark errors with isError so MCP clients can distinguish them from
 *  successful results. Without this flag, an agent may treat an error
 *  message as a successful tool output and feed it back to the LLM. */
function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ── HTTP transport ──────────────────────────────────────────────────────────

interface FetchOpts extends RequestInit {
  timeoutMs?: number;
}

async function niuaFetch<T = unknown>(p: string, options: FetchOpts = {}): Promise<T> {
  if (!API_KEY) {
    throw new Error(
      "Not authenticated. Run `niua-mcp --login` to sign in, or set NIUA_API_KEY. " +
        `Get a key at ${WEB_URL}/settings → Developer.`,
    );
  }

  const { timeoutMs, ...rest } = options;
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const resp = await fetch(`${API_URL}${p}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "User-Agent": `niua-mcp/${SERVER_VERSION}`,
      ...rest.headers,
    },
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(parseGatewayError(resp.status, body));
  }
  return (await resp.json()) as T;
}

// ── Upload (presigned R2 flow) ──────────────────────────────────────────────

const MIME_FOR_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bvh": "model/bvh",
};

function guessMime(filePath: string, fallback: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_FOR_EXT[ext] || fallback;
}

async function niuaUpload(filePath: string, fallbackMime: string): Promise<FinalizeResponse> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const contentType = guessMime(filePath, fallbackMime);

  const presign = await niuaFetch<PresignResponse>("/api/v1/upload/presign", {
    method: "POST",
    body: JSON.stringify({ filename, content_type: contentType, size_bytes: bytes.length }),
  });

  const putResp = await fetch(presign.upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!putResp.ok) {
    const body = await putResp.text();
    throw new Error(`R2 upload failed (${putResp.status}): ${body.slice(0, 200)}`);
  }

  return niuaFetch<FinalizeResponse>("/api/v1/upload/finalize", {
    method: "POST",
    body: JSON.stringify({ asset_id: presign.asset_id }),
  });
}

async function downloadToFile(url: string, filename: string): Promise<string> {
  const outPath = path.resolve(process.cwd(), filename);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

async function presignAndDownload(key: string, filename: string): Promise<string> {
  const { url } = await niuaFetch<{ url: string }>(`/api/download/r2/${key}`);
  return downloadToFile(url, filename);
}

// ── Progress heartbeat ──────────────────────────────────────────────────────
//
// MCP supports progressToken on the request _meta. When the client sets
// it, the server is expected to emit notifications/progress periodically
// during long-running work. For our sync mesh/rig/texture calls (no
// per-stage progress from the gateway), the most we can offer is a
// "still working, Xs elapsed" heartbeat. That's still better than opaque
// 6-minute silence — the agent UI can show a live tick and the user
// stays oriented.

interface ProgressableExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

async function withProgressHeartbeat<T>(
  extra: ProgressableExtra,
  promise: Promise<T>,
  label: string,
): Promise<T> {
  const token = extra._meta?.progressToken;
  if (token === undefined || !extra.sendNotification) {
    return promise;
  }
  const start = Date.now();
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const elapsed = Math.round((Date.now() - start) / 1000);
    extra
      .sendNotification!({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: tick,
          message: `${label} — ${elapsed}s elapsed`,
        },
      })
      .catch(() => {/* ignore — client may have disconnected */});
  }, PROGRESS_HEARTBEAT_MS);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

// ── Common tool annotations ─────────────────────────────────────────────────
//
// MCP clients use these hints to render confirm dialogs intelligently.
// Every tool here is a `write` (charges money) hitting an external API,
// so the defaults are: not read-only, not destructive (we don't delete
// anything), not idempotent (each call returns fresh content), open
// world (talks to a third-party service). The `get_job` and
// `check_balance` overrides flip the relevant hints.

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ── MCP server ──────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "niua", version: SERVER_VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } },
);

// ── Tools ──────────────────────────────────────────────────────────────────

const PRICING_HINT = "Run check_balance for the current price.";

server.registerTool(
  "generate_image",
  {
    title: "Generate image",
    description:
      `Generate an image from a text description. Returns a PNG on the CDN. ${PRICING_HINT}`,
    annotations: { ...WRITE_ANNOTATIONS, title: "Generate image" },
    inputSchema: {
      prompt: z.string().min(1).max(2000)
        .describe("Detailed image description: subject, style, lighting, composition."),
      width: z.number().int().min(512).max(2048).optional().default(1024)
        .describe("Width in pixels (512–2048)."),
      height: z.number().int().min(512).max(2048).optional().default(1024)
        .describe("Height in pixels (512–2048)."),
      filename: z.string().optional().default("generated.png")
        .describe("Output filename for the local save."),
    },
  },
  async ({ prompt, width, height, filename }) => {
    const t0 = Date.now();
    log("tool_call", { tool: "generate_image", width, height });
    try {
      const result = await niuaFetch<GenerateResponse>("/api/v1/generate/image", {
        method: "POST",
        body: JSON.stringify({ prompt, width, height }),
      });
      if (result.status !== "completed") {
        log("tool_fail", { tool: "generate_image", status: result.status });
        return toolError(`Image generation failed: ${formatGenerateError(result)}`);
      }
      const filePath = await downloadToFile(result.url, filename);
      log("tool_ok", { tool: "generate_image", ms: Date.now() - t0 });
      return toolOk([
        {
          type: "text",
          text:
            `Image generated and saved to: ${filePath}\n` +
            `URL: ${result.url}\n` +
            `R2 key: ${result.r2_key}`,
        },
        {
          type: "resource",
          resource: {
            uri: `file://${filePath}`,
            mimeType: "image/png",
            text: prompt.slice(0, 100),
          },
        },
      ]);
    } catch (e) {
      log("tool_error", { tool: "generate_image", error: String(e) });
      return toolError(String(e instanceof Error ? e.message : e));
    }
  },
);

server.registerTool(
  "generate_music",
  {
    title: "Generate music",
    description:
      `Generate music from a text description. Returns a WAV on the CDN. ` +
      `For instrumental tracks, omit \`lyrics\` (or pass only structural [verse]/[chorus] tags). ` +
      `For vocal-led tracks, pass actual lyric text. Control bpm, key, time signature, ` +
      `and vocal language for reproducible results. ${PRICING_HINT}`,
    annotations: { ...WRITE_ANNOTATIONS, title: "Generate music" },
    inputSchema: {
      // ── Core ─────────────────────────────────────────────────
      prompt: z.string().min(1).max(2000)
        .describe("Music description: genre, mood, instruments, tempo. Include structural cues here (e.g. 'soft intro, building chorus, fade-out') rather than in `lyrics` for instrumental tracks."),
      lyrics: z.string().max(4000).optional()
        .describe("Vocal lyrics. Use [verse] / [chorus] / [bridge] tags inside the actual vocal text. To request an instrumental track, OMIT this field (or pass only structural tags with no lyric text — auto-detected as instrumental)."),
      duration: z.number().int().min(5).max(240).optional().default(30)
        .describe("Duration in seconds (5–240). Real tracks aren't tidy multiples of 5/10 — pick a value that fits the brief."),
      filename: z.string().optional().default("generated.wav")
        .describe("Output filename for the local save."),

      // ── Control knobs (the missing ones the incident flagged) ─
      seed: z.number().int().optional()
        .describe("Deterministic seed. Same seed + same params = same output. Use for reproducible BGM."),
      inference_steps: z.number().int().min(4).max(16).optional()
        .describe("DiT sampling steps (4–16). Higher = better quality, slower."),
      thinking: z.boolean().optional()
        .describe("Enable LM chain-of-thought for stronger structural coherence (slower, better)."),
      bpm: z.number().int().min(40).max(220).optional()
        .describe("Tempo in BPM (40–220)."),
      keyscale: z.string().optional()
        .describe("Musical key + mode, e.g. 'C major', 'A minor', 'F# Dorian'."),
      timesignature: z.enum(["3/4", "4/4", "5/4", "6/8", "7/8"]).optional()
        .describe("Time signature."),
      vocal_language: z.string().optional()
        .describe("ISO 639 language code for vocals (e.g. 'en', 'ja', 'ko'). Ignored on instrumental tracks."),

      // ── Audio-to-audio surface ─────────────────────────────
      task_type: z.enum([
        "text2music", "cover", "cover-nofsq", "repaint", "lego", "extract", "complete",
      ]).optional().describe(
        "Generation task. Default `text2music`. `cover`/`cover-nofsq` re-render `src_audio` toward the prompt (style transfer). `repaint` regenerates a time range of `src_audio` (set `repainting_start`/`end`). `lego` does stem mixing. `extract` recovers semantic codes. `complete` extends `src_audio` to the requested duration."
      ),
      src_audio: z.string().optional()
        .describe("Source audio for audio2audio tasks. HTTPS URL or R2 key (e.g. `uploads/<user>/track.wav`). Required by every `task_type` except `text2music`."),
      reference_audio: z.string().optional()
        .describe("Reference audio for style transfer. URL or R2 key."),
      audio_cover_strength: z.number().min(0).max(1).optional()
        .describe("Cover task transformation strength (0–1). 0 = nearly unchanged, 1 = full re-render."),
      cover_noise_strength: z.number().min(0).max(1).optional()
        .describe("Cover noise injection strength (0–1)."),
      repainting_start: z.number().min(0).optional()
        .describe("Repaint start time in seconds (used by `task_type: repaint`)."),
      repainting_end: z.number().min(0).optional()
        .describe("Repaint end time in seconds (used by `task_type: repaint`)."),
    },
  },
  async (args) => {
    const { filename = "generated.wav", ...gatewayParams } = args;
    const t0 = Date.now();
    log("tool_call", { tool: "generate_music", duration: args.duration });
    try {
      // Forward EVERY caller-supplied param to the gateway. The gateway
      // already validates against its ParamSpec list and returns a 400
      // for anything out of range. Passing the whole object through
      // means future-added params land here automatically, no MCP
      // rebuild needed (the per-param Zod schemas are documentation /
      // client-side guard; the gateway is the source of truth).
      const result = await niuaFetch<GenerateResponse>("/api/v1/generate/music", {
        method: "POST",
        body: JSON.stringify(gatewayParams),
      });
      if (result.status !== "completed") {
        log("tool_fail", { tool: "generate_music", status: result.status });
        return toolError(`Music generation failed: ${formatGenerateError(result)}`);
      }
      const filePath = await downloadToFile(result.url, filename);
      log("tool_ok", { tool: "generate_music", ms: Date.now() - t0 });
      return toolOk([
        {
          type: "text",
          text:
            `Music generated (${args.duration ?? 30}s) and saved to: ${filePath}\n` +
            `URL: ${result.url}\n` +
            `R2 key: ${result.r2_key}`,
        },
      ]);
    } catch (e) {
      log("tool_error", { tool: "generate_music", error: String(e) });
      return toolError(String(e instanceof Error ? e.message : e));
    }
  },
);

server.registerTool(
  "generate_mesh",
  {
    title: "Generate textured 3D mesh",
    description:
      `Generate a textured 3D mesh (GLB with PBR materials) from a single image. ` +
      `One call returns the finished GLB on the CDN. Provide either a local image ` +
      `path (will be uploaded) or an R2 image key from a previous generate_image. ` +
      `Sync call, holds open for several minutes. ${PRICING_HINT}`,
    annotations: { ...WRITE_ANNOTATIONS, title: "Generate textured 3D mesh" },
    inputSchema: {
      image_path: z.string().optional()
        .describe("Path to a local image file (PNG/JPG/WebP)."),
      image_key: z.string().optional()
        .describe("R2 key from a previous generate_image call (skip image_path)."),
      resolution: z.union([z.literal(1024), z.literal(1536)]).optional().default(1024)
        .describe("Cascade resolution: 1024 (standard) or 1536 (premium, hero assets)."),
      filename: z.string().optional().default("mesh.glb")
        .describe("Output filename for the local save."),
    },
  },
  async ({ image_path, image_key, resolution, filename }, extra) => {
    const t0 = Date.now();
    log("tool_call", { tool: "generate_mesh", resolution });
    try {
      let key = image_key;
      if (image_path && !key) {
        const up = await niuaUpload(image_path, "image/png");
        key = up.r2_key;
      }
      if (!key) {
        return toolError("Provide either image_path or image_key.");
      }

      const fetchPromise = niuaFetch<GenerateResponse>("/api/v1/generate/mesh", {
        method: "POST",
        body: JSON.stringify({ image_key: key, resolution }),
        timeoutMs: LONG_TIMEOUT_MS,
      });
      const result = await withProgressHeartbeat(extra, fetchPromise, "generating mesh");

      if (result.status !== "completed") {
        log("tool_fail", { tool: "generate_mesh", status: result.status });
        return toolError(`Mesh generation failed: ${formatGenerateError(result)}`);
      }
      const filePath = await downloadToFile(result.url, filename);
      log("tool_ok", { tool: "generate_mesh", ms: Date.now() - t0 });
      return toolOk([
        {
          type: "text",
          text:
            `Textured mesh saved to: ${filePath}\n` +
            `URL: ${result.url}\n` +
            `R2 key: ${result.r2_key}\n` +
            `Import this GLB into Unity, Unreal, Blender, or Godot.`,
        },
      ]);
    } catch (e) {
      log("tool_error", { tool: "generate_mesh", error: String(e) });
      return toolError(String(e instanceof Error ? e.message : e));
    }
  },
);

server.registerTool(
  "generate_mesh_texture",
  {
    title: "Re-texture mesh",
    description:
      `Re-texture an existing GLB with PBR materials conditioned on a reference image. ` +
      `Useful for iterating on the look of a mesh without re-generating geometry. ${PRICING_HINT}`,
    annotations: { ...WRITE_ANNOTATIONS, title: "Re-texture mesh" },
    inputSchema: {
      mesh_key: z.string().min(1).describe("R2 key of the GLB to re-texture."),
      image_key: z.string().min(1)
        .describe("R2 key of the reference image (color/material conditioning)."),
      filename: z.string().optional().default("retextured.glb")
        .describe("Output filename for the local save."),
    },
  },
  async ({ mesh_key, image_key, filename }, extra) => {
    const t0 = Date.now();
    log("tool_call", { tool: "generate_mesh_texture" });
    try {
      const fetchPromise = niuaFetch<GenerateResponse>("/api/v1/generate/texture", {
        method: "POST",
        body: JSON.stringify({ mesh_key, image_key }),
        timeoutMs: LONG_TIMEOUT_MS,
      });
      const result = await withProgressHeartbeat(extra, fetchPromise, "re-texturing mesh");
      if (result.status !== "completed") {
        log("tool_fail", { tool: "generate_mesh_texture", status: result.status });
        return toolError(`Texture pass failed: ${formatGenerateError(result)}`);
      }
      const filePath = await downloadToFile(result.url, filename);
      log("tool_ok", { tool: "generate_mesh_texture", ms: Date.now() - t0 });
      return toolOk([
        {
          type: "text",
          text:
            `Re-textured mesh saved to: ${filePath}\n` +
            `URL: ${result.url}\n` +
            `R2 key: ${result.r2_key}`,
        },
      ]);
    } catch (e) {
      log("tool_error", { tool: "generate_mesh_texture", error: String(e) });
      return toolError(String(e instanceof Error ? e.message : e));
    }
  },
);

server.registerTool(
  "generate_motion",
  {
    title: "Motion capture from video",
    description:
      `Extract motion capture from a video. Async — returns a job_id; poll get_job ` +
      `until complete (typical runtime 1–3 minutes), then download the BVH. ${PRICING_HINT}`,
    annotations: { ...WRITE_ANNOTATIONS, title: "Motion capture from video" },
    inputSchema: {
      video_path: z.string().optional().describe("Path to a local video file."),
      video_key: z.string().optional()
        .describe("R2 key of a previously uploaded video (skip video_path)."),
      fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional().default(30)
        .describe("Output framerate."),
      export_fbx: z.boolean().optional().default(true)
        .describe("Also produce an .fbx alongside the .bvh."),
    },
  },
  async ({ video_path, video_key, fps, export_fbx }) => {
    const t0 = Date.now();
    log("tool_call", { tool: "generate_motion", fps });
    try {
      let vkey = video_key;
      if (video_path && !vkey) {
        const up = await niuaUpload(video_path, "video/mp4");
        vkey = up.r2_key;
      }
      if (!vkey) {
        return toolError("Provide either video_path or video_key.");
      }
      const result = await niuaFetch<GenerateProcessingResponse | GenerateFailedResponse>(
        "/api/v1/generate/motion",
        {
          method: "POST",
          body: JSON.stringify({ video_key: vkey, fps, stationary: true, export_fbx }),
        },
      );
      if (result.status === "failed") {
        log("tool_fail", { tool: "generate_motion" });
        return toolError(`Motion capture submission failed: ${formatGenerateError(result)}`);
      }
      log("tool_ok", { tool: "generate_motion", job_id: result.job_id, ms: Date.now() - t0 });
      return toolOk([
        {
          type: "text",
          text:
            `Motion capture submitted. job_id: ${result.job_id}\n` +
            `Poll with get_job until status="completed". Typical runtime: 1–3 minutes.`,
        },
      ]);
    } catch (e) {
      log("tool_error", { tool: "generate_motion", error: String(e) });
      return toolError(String(e instanceof Error ? e.message : e));
    }
  },
);

server.registerTool(
  "generate_text2motion",
  {
    title: "Generate motion from text",
    description: `Generate a BVH animation from a text prompt. Returns a BVH on the CDN. ${PRICING_HINT}`,
    annotations: { ...WRITE_ANNOTATIONS, title: "Generate motion from text" },
    inputSchema: {
      prompt: z.string().min(1).max(500)
        .describe("Motion description: e.g. 'a person doing a backflip', 'walking nervously'."),
      duration: z.number().min(1).max(10).optional().default(4)
        .describe("Target duration in seconds (1–10)."),
      filename: z.string().optional().default("animation.bvh")
        .describe("Output filename for the local save."),
    },
  },
  async ({ prompt, duration, filename }) => {
    const t0 = Date.now();
    log("tool_call", { tool: "generate_text2motion", duration });
    try {
      const result = await niuaFetch<GenerateResponse>("/api/v1/generate/text2motion", {
        method: "POST",
        body: JSON.stringify({ prompt, duration }),
      });
      if (result.status !== "completed") {
        log("tool_fail", { tool: "generate_text2motion", status: result.status });
        return toolError(`Animation generation failed: ${formatGenerateError(result)}`);
      }
      const filePath = await downloadToFile(result.url, filename);
      log("tool_ok", { tool: "generate_text2motion", ms: Date.now() - t0 });
      return toolOk([{ type: "text", text: `Animation saved to: ${filePath}\nURL: ${result.url}` }]);
    } catch (e) {
      log("tool_error", { tool: "generate_text2motion", error: String(e) });
      return toolError(String(e instanceof Error ? e.message : e));
    }
  },
);

server.registerTool(
  "generate_rig",
  {
    title: "Auto-rig user-authored mesh",
    description:
      `Auto-rig a part-separated GLB mesh (use this for user-authored meshes from ` +
      `Blender, Maya, Sketchfab, etc.). Do NOT chain this after generate_mesh — ` +
      `diffusion-generated meshes are one continuous surface and the result of ` +
      `rigging one looks degraded. Long-running call (~5–10 min). ${PRICING_HINT}`,
    annotations: { ...WRITE_ANNOTATIONS, title: "Auto-rig user-authored mesh" },
    inputSchema: {
      mesh_key: z.string().min(1)
        .describe("R2 key of the GLB to rig. Must be a part-separated mesh (DCC export, not generated)."),
      filename: z.string().optional().default("rigged.glb")
        .describe("Output filename for the local save."),
    },
  },
  async ({ mesh_key, filename }, extra) => {
    const t0 = Date.now();
    log("tool_call", { tool: "generate_rig" });
    try {
      const fetchPromise = niuaFetch<GenerateResponse>("/api/v1/generate/rig", {
        method: "POST",
        body: JSON.stringify({ mesh_key }),
        timeoutMs: LONG_TIMEOUT_MS,
      });
      const result = await withProgressHeartbeat(extra, fetchPromise, "rigging mesh");
      if (result.status === "failed") {
        log("tool_fail", { tool: "generate_rig" });
        return toolError(`Rigging failed: ${formatGenerateError(result)}`);
      }
      if (result.status === "processing") {
        log("tool_ok", { tool: "generate_rig", job_id: result.job_id, async: true });
        return toolOk([{
          type: "text",
          text: `Rig job submitted (job_id: ${result.job_id}). Poll get_job for completion.`,
        }]);
      }
      const filePath = await downloadToFile(result.url, filename);
      log("tool_ok", { tool: "generate_rig", ms: Date.now() - t0 });
      return toolOk([{ type: "text", text: `Rigged model saved to: ${filePath}\nURL: ${result.url}` }]);
    } catch (e) {
      log("tool_error", { tool: "generate_rig", error: String(e) });
      return toolError(String(e instanceof Error ? e.message : e));
    }
  },
);

server.registerTool(
  "get_job",
  {
    title: "Look up a job",
    description:
      "Look up a job by id. Returns status (pending / running / completed / failed) " +
      "and, when complete, the R2 output key + a public CDN URL.",
    annotations: { ...READ_ANNOTATIONS, title: "Look up a job" },
    inputSchema: {
      job_id: z.string().min(1).describe("Job UUID returned by a generate_* tool."),
      download_to: z.string().optional()
        .describe("If complete, save the asset to this filename."),
    },
  },
  async ({ job_id, download_to }) => {
    log("tool_call", { tool: "get_job", job_id });
    try {
      const job = await niuaFetch<JobResponse>(`/api/v1/jobs/${job_id}`);
      const lines = [`Job ${job_id}: ${job.status}`];
      if (job.error) lines.push(`Error: ${job.error}`);
      if (job.gpu_seconds) lines.push(`GPU time: ${job.gpu_seconds.toFixed(1)}s`);

      if (job.status === "completed" && job.output_key) {
        lines.push(`Output key: ${job.output_key}`);
        if (job.url) lines.push(`URL: ${job.url}`);
        if (download_to) {
          try {
            const filePath = await presignAndDownload(job.output_key, download_to);
            lines.push(`Saved to: ${filePath}`);
          } catch (e) {
            lines.push(`Download failed: ${String(e instanceof Error ? e.message : e)}`);
          }
        } else {
          lines.push(`(Pass download_to to save the asset locally.)`);
        }
      }
      log("tool_ok", { tool: "get_job", status: job.status });
      return toolOk([{ type: "text", text: lines.join("\n") }]);
    } catch (e) {
      log("tool_error", { tool: "get_job", error: String(e) });
      return toolError(String(e instanceof Error ? e.message : e));
    }
  },
);

server.registerTool(
  "check_balance",
  {
    title: "Wallet balance and live pricing",
    description: "Show the user's wallet balance and the current per-service pricing.",
    annotations: { ...READ_ANNOTATIONS, title: "Wallet balance and live pricing" },
    inputSchema: {},
  },
  async () => {
    log("tool_call", { tool: "check_balance" });
    try {
      const wallet = await niuaFetch<WalletStatus>("/api/wallet/status");
      const lines = [
        `Wallet: ${wallet.wallet_display ?? `$${(wallet.wallet_cents / 100).toFixed(2)}`}`,
      ];
      try {
        const pricesRaw = await niuaFetch<PriceEntry[] | { prices: PriceEntry[] }>(
          "/api/billing/prices",
        );
        const items: PriceEntry[] = Array.isArray(pricesRaw)
          ? pricesRaw
          : pricesRaw?.prices ?? [];
        if (items.length > 0) {
          lines.push("");
          lines.push("Pricing:");
          for (const p of items) {
            lines.push(`  ${p.service}: ${p.price_display ?? `${p.price_cents}¢`}`);
          }
        }
      } catch {
        // Pricing endpoint shape can drift; balance is the load-bearing answer.
      }
      log("tool_ok", { tool: "check_balance" });
      return toolOk([{ type: "text", text: lines.join("\n") }]);
    } catch (e) {
      log("tool_error", { tool: "check_balance", error: String(e) });
      return toolError(String(e instanceof Error ? e.message : e));
    }
  },
);

// ── Resources ──────────────────────────────────────────────────────────────
//
// Surface useful read-only references via the MCP resources/read flow so
// agents can grab them without invoking a tool (and without charging the
// wallet). URIs:
//   - niua://docs/agents         Long-form agent manual (this server's docs/AGENTS.md)
//   - niua://docs/quickstart     Three-step onboarding (matches /api-docs hero)
//   - niua://pricing/live        Live PRICES feed, rendered as Markdown
//   - niua://models/catalog      /api/v1/models snapshot, rendered as Markdown
//
// Static docs (AGENTS.md and any future siblings) live under the package's
// docs/ directory and ship with the npm package. We resolve the path
// relative to this source file so it works both from `node dist/index.js`
// and via `npx -y github:OhaoTech/niua-mcp-server` (the dist files keep
// the same docs/../docs/ relative layout as the source tree).
//
// Read the file lazily on resource access — not at startup — so a docs
// file missing from a bad install doesn't crash the whole server. Agents
// reading a missing resource get a clear "doc unavailable" message.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.resolve(__dirname, "..", "docs");

function loadDoc(filename: string): { text: string; ok: boolean } {
  try {
    const full = path.join(DOCS_DIR, filename);
    return { text: fs.readFileSync(full, "utf8"), ok: true };
  } catch (e) {
    return {
      text: `Documentation file unavailable: ${filename}\n\nError: ${String(e instanceof Error ? e.message : e)}\n\nThis suggests a broken install. Try reinstalling the MCP server, or report at https://github.com/OhaoTech/niua-mcp-server/issues.`,
      ok: false,
    };
  }
}

const QUICKSTART_MD = `# NIUA Quickstart

1. **Get an API key** — sign in at ${WEB_URL} → Settings → Developer → Create.
   Keys start with \`niua_live_\`.

2. **Generate your first asset.** One POST returns a public CDN URL.
   \`\`\`bash
   curl -X POST ${API_URL}/api/v1/generate/image \\
     -H "Authorization: Bearer $NIUA_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"prompt":"a cozy game-jam tavern, isometric pixel art","width":1024,"height":1024}'
   \`\`\`

3. **(Optional) Plug it into your AI agent.** Drop this into your client's
   MCP config and restart:
   \`\`\`json
   {
     "mcpServers": {
       "niua": {
         "command": "npx",
         "args": ["-y", "@ohao/mcp-server"],
         "env": { "NIUA_API_KEY": "niua_live_your_key_here" }
       }
     }
   }
   \`\`\`

Your agent now has seven generation tools: image, music, mesh, texture,
motion, text-to-motion, rig.
`;

server.registerResource(
  "agents-manual",
  "niua://docs/agents",
  {
    title: "NIUA Agent Manual",
    description:
      "Long-form guide for AI agents using NIUA: when to call NIUA, " +
      "workflow recipes (image → mesh, music with lyrics control, etc.), " +
      "per-modality prompt patterns, error handling, and cost-awareness " +
      "rules. The recommended first read for any agent picking up the " +
      "NIUA tools.",
    mimeType: "text/markdown",
  },
  async (uri) => {
    const doc = loadDoc("AGENTS.md");
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: doc.text }] };
  },
);

server.registerResource(
  "quickstart",
  "niua://docs/quickstart",
  {
    title: "NIUA Quickstart",
    description: "Three-step onboarding: API key → first call → MCP install.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: QUICKSTART_MD }],
  }),
);

server.registerResource(
  "pricing-live",
  "niua://pricing/live",
  {
    title: "Live NIUA pricing",
    description: "Per-service pricing in USD cents, fetched from /api/billing/prices on read.",
    mimeType: "text/markdown",
  },
  async (uri) => {
    try {
      const pricesRaw = await niuaFetch<PriceEntry[] | { prices: PriceEntry[] }>(
        "/api/billing/prices",
      );
      const items: PriceEntry[] = Array.isArray(pricesRaw)
        ? pricesRaw
        : pricesRaw?.prices ?? [];
      const rows = items
        .map((p) => `| \`${p.service}\` | ${p.price_display ?? `${p.price_cents}¢`} |`)
        .join("\n");
      const md = `# NIUA Pricing (live)\n\n| Service | Price |\n|---|---|\n${rows}\n`;
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }] };
    } catch (e) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: `Pricing unavailable: ${String(e instanceof Error ? e.message : e)}`,
          },
        ],
      };
    }
  },
);

server.registerResource(
  "models-catalog",
  "niua://models/catalog",
  {
    title: "NIUA model catalog",
    description: "Available models per generation type, fetched from /api/v1/models on read.",
    mimeType: "text/markdown",
  },
  async (uri) => {
    try {
      const catalog = await niuaFetch<{
        models: Array<{ pinned_id: string; type: string; provider?: { name: string } }>;
      }>("/api/v1/models");
      const byType = new Map<string, string[]>();
      for (const m of catalog.models ?? []) {
        const list = byType.get(m.type) ?? [];
        list.push(`- \`${m.pinned_id}\`${m.provider?.name ? ` (${m.provider.name})` : ""}`);
        byType.set(m.type, list);
      }
      const sections = [...byType.entries()]
        .map(([type, lines]) => `## ${type}\n\n${lines.join("\n")}`)
        .join("\n\n");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: `# NIUA Model Catalog (live)\n\n${sections}\n`,
          },
        ],
      };
    } catch (e) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: `Catalog unavailable: ${String(e instanceof Error ? e.message : e)}`,
          },
        ],
      };
    }
  },
);

// ── Prompts ────────────────────────────────────────────────────────────────
//
// Canned brief templates. Agents (and humans through MCP clients) can
// trigger them by name; the server returns a structured prompt the user
// or agent can refine before calling generate_*. Each template encodes
// the prompt-engineering best practices we figured out the hard way
// (centred subject, white background, 3/4 view, etc.).

server.registerPrompt(
  "prop_brief",
  {
    title: "Brief: 3D prop",
    description:
      "Compose a generate_image → generate_mesh brief for a static 3D prop. " +
      "Embeds the prompt-quality rules that make downstream mesh generation work " +
      "(centred subject, white background, 3/4 view, soft lighting).",
    argsSchema: {
      subject: z.string().describe("Subject of the prop, e.g. 'weathered wooden crate with iron banding'."),
    },
  },
  async ({ subject }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate a textured 3D prop for the following subject, in two calls.\n\n` +
            `**Subject:** ${subject}\n\n` +
            `**Step 1.** Call \`generate_image\` with this prompt:\n` +
            `> ${subject}, centered, white background, 3/4 view, soft studio lighting, photographic\n\n` +
            `**Step 2.** Take the \`r2_key\` from step 1 and call \`generate_mesh\` with:\n` +
            `> \`{ "image_key": "<that r2_key>" }\`\n\n` +
            `The result is a textured GLB ready to import into Unity, Unreal, Blender, or Godot.`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  "character_brief",
  {
    title: "Brief: character concept image",
    description:
      "Compose a generate_image brief for a character concept (full body, t-pose). " +
      "Stops at the image stage: rig and animation are deferred until you have a " +
      "part-separated mesh, which generated 3D doesn't currently produce.",
    argsSchema: {
      subject: z.string().describe("Character subject, e.g. 'fantasy orc warrior with glowing axe'."),
      style: z.string().optional().describe("Optional style suffix, e.g. 'anime line art', 'photorealistic'."),
    },
  },
  async ({ subject, style }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate a character concept image with \`generate_image\`.\n\n` +
            `**Subject:** ${subject}\n` +
            (style ? `**Style:** ${style}\n` : "") +
            `\nPrompt to use:\n` +
            `> ${subject}${style ? `, ${style}` : ""}, full body, T-pose, ` +
            `centered, neutral background, soft even lighting, no motion blur\n\n` +
            `Note: rigging a generated mesh produces visibly degraded results today ` +
            `(generated 3D is one continuous surface, but auto-rig needs part-separated geometry). ` +
            `Use this image as a reference for hand-modelling in Blender / Maya, ` +
            `then rig that part-separated mesh with \`generate_rig\`.`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  "music_brief",
  {
    title: "Brief: music track",
    description:
      "Compose a generate_music brief with mood, instrumentation, and duration. " +
      "Optional lyrics block.",
    argsSchema: {
      mood: z.string().describe("Mood / energy, e.g. 'tense, percussive', 'soft, cozy'."),
      use_case: z.string().describe("Where the track plays, e.g. 'boss fight', 'tavern background', 'main menu'."),
      duration_seconds: z.string().optional()
        .describe("Target duration in seconds (e.g. 45). Defaults to 30."),
    },
  },
  async ({ mood, use_case, duration_seconds }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate a music track with \`generate_music\` for the following:\n\n` +
            `**Use case:** ${use_case}\n` +
            `**Mood:** ${mood}\n` +
            `**Duration:** ${duration_seconds || "30"} seconds\n\n` +
            `Prompt to use:\n` +
            `> ${mood}, ${use_case} music, instrumentation appropriate to the scene, ` +
            `${duration_seconds || "30"} second loop\n\n` +
            `Pass \`duration\` to \`generate_music\` so the track lands at the requested length.`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  "motion_brief",
  {
    title: "Brief: text-to-motion clip",
    description:
      "Compose a generate_text2motion brief — single continuous action, short duration.",
    argsSchema: {
      action: z.string().describe("Single continuous action verb phrase, e.g. 'walking nervously', 'doing a backflip'."),
    },
  },
  async ({ action }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate a motion clip with \`generate_text2motion\`.\n\n` +
            `**Action:** ${action}\n\n` +
            `Prompt to use:\n` +
            `> ${action}\n\n` +
            `Keep the action single + continuous — text-to-motion handles one ` +
            `discrete movement at a time. For sequences, generate each clip ` +
            `separately and stitch them in your engine.`,
        },
      },
    ],
  }),
);

// ── Start server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("ready", { version: SERVER_VERSION, api_url: API_URL });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

} // end normal MCP server mode
