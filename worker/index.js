/* OjiMate の会話用 Cloudflare Worker。
   Secrets:
     npx wrangler secret put OJIMATE_SECRET
     npx wrangler secret put ANTHROPIC_API_KEY  # PROVIDER=anthropic の場合のみ
*/

const CF_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const IS_FRONTIER = /^claude-(opus|sonnet|fable)-(5|4-[678])/.test(ANTHROPIC_MODEL);
const MAX_BODY_BYTES = 20 * 1024;
const MAX_PROMPT_CHARS = 4_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const ALLOWED_PATHS = new Set(["/", "/chat"]);
const PRODUCTION_ORIGINS = new Set(["https://tsukuriba.org"]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function isAllowedOrigin(origin) {
  if (PRODUCTION_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type,x-ojimate-key",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function responseHeaders(cors, contentType) {
  return {
    ...cors,
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

function jsonResponse(cors, status, requestId, code, message) {
  return Response.json(
    { error: { code, message, requestId } },
    { status, headers: responseHeaders(cors, "application/json; charset=utf-8") },
  );
}

function log(level, fields) {
  const line = JSON.stringify({ service: "ojimate-agent", ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

async function verifySecret(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

async function readBoundedJson(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "リクエストが大きすぎます");
  }
  if (!request.body) throw new HttpError(400, "empty_body", "JSON本文が必要です");

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel("body limit exceeded");
        throw new HttpError(413, "body_too_large", "リクエストが大きすぎます");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_json", "正しいJSONを送ってください");
  }
}

function validatePrompt(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(422, "invalid_body", "JSONオブジェクトを送ってください");
  }
  const system = body.system ?? "";
  const user = body.user;
  if (typeof system !== "string" || system.length > MAX_PROMPT_CHARS) {
    throw new HttpError(422, "invalid_system", `systemは${MAX_PROMPT_CHARS}文字以内にしてください`);
  }
  if (typeof user !== "string" || user.trim().length === 0 || user.length > MAX_PROMPT_CHARS) {
    throw new HttpError(422, "invalid_user", `userは1〜${MAX_PROMPT_CHARS}文字にしてください`);
  }
  return { system, user };
}

function sseHeaders(cors, requestId) {
  return responseHeaders(
    { ...cors, "x-request-id": requestId, "x-accel-buffering": "no" },
    "text/event-stream; charset=utf-8",
  );
}

function toAnthropicSSE(cfStream) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return cfStream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const event = JSON.parse(payload);
          const raw = event.choices?.[0]?.delta?.content ?? event.response;
          if (raw == null || String(raw) === "") continue;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: String(raw) },
          })}\n\n`));
        } catch {
          // Malformed upstream events are ignored instead of being reflected.
        }
      }
    },
  }));
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new HttpError(504, "upstream_timeout", "AIの応答が時間切れになりました")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runWorkersAI(env, system, user, cors, requestId) {
  if (!env.AI) throw new HttpError(503, "ai_unavailable", "AIを利用できません");
  const stream = await withTimeout(
    env.AI.run(CF_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 256,
      temperature: 0.9,
      stream: true,
    }),
    UPSTREAM_TIMEOUT_MS,
  );
  return new Response(toAnthropicSSE(stream), { headers: sseHeaders(cors, requestId) });
}

function anthropicHeaders(env) {
  const headers = {
    "content-type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY.trim(),
    "anthropic-version": "2023-06-01",
  };
  if (IS_FRONTIER) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  return headers;
}

function anthropicPayload(system, user) {
  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: 300,
    stream: true,
    system,
    messages: [{ role: "user", content: user }],
  };
  if (IS_FRONTIER) {
    payload.output_config = { effort: "low" };
    payload.fallbacks = "default";
  }
  return payload;
}

async function readErrorSnippet(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (size < 4_096) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = 4_096 - size;
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) break;
    }
    await reader.cancel("error response limit reached");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function runAnthropic(env, system, user, cors, requestId) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "anthropic_unavailable", "AIを利用できません");
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders(env),
    body: JSON.stringify(anthropicPayload(system, user)),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!upstream.ok) {
    const detail = await readErrorSnippet(upstream);
    log("error", { message: "anthropic rejected request", requestId, status: upstream.status, detail });
    throw new HttpError(502, "upstream_error", "AIの応答に失敗しました");
  }
  return new Response(upstream.body, { headers: sseHeaders(cors, requestId) });
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";

    if (!isAllowedOrigin(origin)) {
      log("error", { message: "origin denied", requestId, method: request.method, path: url.pathname });
      return jsonResponse({}, 403, requestId, "origin_denied", "このオリジンからは利用できません");
    }
    const cors = corsHeaders(origin);
    if (!ALLOWED_PATHS.has(url.pathname)) {
      return jsonResponse(cors, 404, requestId, "not_found", "エンドポイントが見つかりません");
    }
    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers.get("access-control-request-method");
      if (requestedMethod && requestedMethod !== "POST") {
        return jsonResponse(cors, 405, requestId, "method_not_allowed", "POSTだけ利用できます");
      }
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: { code: "method_not_allowed", message: "POSTだけ利用できます", requestId } }),
        { status: 405, headers: { ...responseHeaders(cors, "application/json; charset=utf-8"), allow: "POST, OPTIONS" } },
      );
    }
    const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return jsonResponse(cors, 415, requestId, "unsupported_media_type", "Content-Typeはapplication/jsonにしてください");
    }
    if (!env.OJIMATE_SECRET) {
      log("error", { message: "OJIMATE_SECRET is not configured", requestId });
      return jsonResponse(cors, 503, requestId, "service_unavailable", "サービスを利用できません");
    }
    if (!await verifySecret(request.headers.get("x-ojimate-key"), env.OJIMATE_SECRET)) {
      log("error", { message: "authentication failed", requestId, path: url.pathname });
      return jsonResponse(cors, 401, requestId, "unauthorized", "認証できませんでした");
    }

    try {
      const { system, user } = validatePrompt(await readBoundedJson(request));
      const provider = env.PROVIDER || "workers-ai";
      log("info", { message: "request accepted", requestId, provider, path: url.pathname });
      if (provider === "workers-ai") return await runWorkersAI(env, system, user, cors, requestId);
      if (provider === "anthropic") return await runAnthropic(env, system, user, cors, requestId);
      throw new HttpError(503, "invalid_provider", "AIの設定が正しくありません");
    } catch (error) {
      if (error instanceof HttpError) {
        log(error.status >= 500 ? "error" : "info", { message: error.message, requestId, code: error.code, status: error.status });
        return jsonResponse(cors, error.status, requestId, error.code, error.message);
      }
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      log("error", {
        message: timedOut ? "upstream timeout" : "unhandled request error",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse(
        cors,
        timedOut ? 504 : 500,
        requestId,
        timedOut ? "upstream_timeout" : "internal_error",
        timedOut ? "AIの応答が時間切れになりました" : "処理中にエラーが発生しました",
      );
    }
  },
};
