/* OjiMate の「おじさん」を喋らせるためのエージェント用プロキシ。
   トガメ（tsukuriba.org/togame/）の worker/index.js と同じ構成の移植版。

   既定は Cloudflare Workers AI（無料枠 10,000ニューロン/日）。
   PROVIDER を "anthropic" に変えると Claude を直接叩く形に戻せる。

   デプロイ:
     npx wrangler deploy
     npx wrangler secret put OJIMATE_SECRET      # 自分で決める合言葉。index.html側にも同じものを入れる
     npx wrangler secret put ANTHROPIC_API_KEY   # PROVIDER="anthropic" のときだけ必要

   合言葉は、このWorkerを他人に勝手に使われるのを防ぐためのもの。
   デプロイ後に出るWorkerのURLを、OjiMateの画面で「おじさん」の名前を
   長押しすると出る設定ダイアログに、合言葉とあわせて入れる。 */

const PROVIDER = "workers-ai";   // "workers-ai" | "anthropic"

const CF_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const IS_FRONTIER = /^claude-(opus|sonnet|fable)-(5|4-[678])/.test(ANTHROPIC_MODEL);

/* ここに載っていないオリジンからは叩けない。自分のGitHub Pages等のURLに書き換える */
const ALLOWED_ORIGINS = [
  "http://localhost:8123",   // ローカル検証用
];

function corsHeaders(origin){
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "content-type,x-ojimate-key",
    "access-control-allow-methods": "POST,OPTIONS",
    "vary": "origin",
  };
}

const sseHeaders = h => ({
  ...h,
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
});

/* ---------------- Workers AI ---------------- */

function toAnthropicSSE(cfStream){
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  return cfStream.pipeThrough(new TransformStream({
    transform(chunk, ctrl){
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for(const line of lines){
        const t = line.trim();
        if(!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if(payload === "[DONE]" || !payload) continue;
        let ev;
        try{ ev = JSON.parse(payload); }catch(e){ continue; }
        const raw = (ev.choices && ev.choices[0] && ev.choices[0].delta
          && ev.choices[0].delta.content != null)
          ? ev.choices[0].delta.content
          : ev.response;
        if(raw == null) continue;
        const text = String(raw);
        if(text === "") continue;
        ctrl.enqueue(enc.encode("data: " + JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        }) + "\n\n"));
      }
    },
  }));
}

async function runWorkersAI(env, system, user, h){
  if(!env.AI){
    return new Response("AIバインディングが未設定（wrangler.toml の [ai] を確認）", { status:500, headers:h });
  }
  try{
    const stream = await env.AI.run(CF_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user },
      ],
      max_tokens: 256,
      temperature: 0.9,
      stream: true,
    });
    return new Response(toAnthropicSSE(stream), { headers: sseHeaders(h) });
  }catch(e){
    return new Response("Workers AI エラー: " + ((e && e.message) || e), { status:500, headers:h });
  }
}

/* ---------------- Anthropic（戻したいとき用） ---------------- */

function anthropicHeaders(env){
  const h = {
    "content-type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY.trim(),
    "anthropic-version": "2023-06-01",
  };
  if(IS_FRONTIER) h["anthropic-beta"] = "server-side-fallback-2026-07-01";
  return h;
}

function anthropicPayload(system, user){
  const p = {
    model: ANTHROPIC_MODEL,
    max_tokens: 300,
    stream: true,
    system,
    messages: [{ role: "user", content: user }],
  };
  if(IS_FRONTIER){
    p.output_config = { effort: "low" };
    p.fallbacks = "default";
  }
  return p;
}

async function runAnthropic(env, system, user, h){
  if(!env.ANTHROPIC_API_KEY){
    return new Response("ANTHROPIC_API_KEY が未設定", { status:500, headers:h });
  }
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders(env),
    body: JSON.stringify(anthropicPayload(system, user)),
  });
  if(!upstream.ok){
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { ...h, "content-type": "application/json" },
    });
  }
  return new Response(upstream.body, { headers: sseHeaders(h) });
}

/* ---------------- 入口 ---------------- */

export default {
  async fetch(req, env){
    const h = corsHeaders(req.headers.get("origin") || "");

    if(req.method === "OPTIONS") return new Response(null, { status:204, headers:h });
    if(req.method !== "POST")    return new Response("POSTだけ", { status:405, headers:h });
    if(req.headers.get("x-ojimate-key") !== env.OJIMATE_SECRET)
      return new Response("合言葉が違う", { status:401, headers:h });

    let body;
    try{ body = await req.json(); }
    catch(e){ return new Response("JSONが読めない", { status:400, headers:h }); }

    const system = String(body.system || "").slice(0, 4000);
    const user   = String(body.user   || "").slice(0, 4000);
    if(!user) return new Response("userが空", { status:400, headers:h });

    return PROVIDER === "anthropic"
      ? runAnthropic(env, system, user, h)
      : runWorkersAI(env, system, user, h);
  },
};
