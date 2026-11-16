// 学習ローテーション用 YouTube Data API プロキシ（Cloudflare Workers）
//
// 役割: フロント（GitHub Pages の画面）からのリクエストに、秘密のAPIキーを付けて
//       YouTube Data API へ中継する。これにより、使う人はキー設定が不要になる。
//
// 大事な点:
//  - APIキーはこのコードには書かない。Cloudflare の環境変数(Secret) YOUTUBE_API_KEY に入れる。
//  - 中継先は playlistItems / channels だけに制限（各1ユニット）。
//    高コストな search(100ユニット) は許可しない＝クォータ枯渇による乱用を防ぐ。
//  - 同じ問い合わせは6時間キャッシュして、1日のAPI利用上限(クォータ)を節約する。
//  - レスポンスには、許可したオリジンだけに CORS を付けて返す。

const ALLOWED_ENDPOINTS = new Set(["playlistItems", "channels"]);

// 画面を置いている場所（ここからの呼び出しだけ許可）。増えたら足す。
const ALLOWED_ORIGINS = [
  "https://haizarakumin-collab.github.io",
  "http://localhost:8765",
  "http://localhost:8770",
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-App-Token, X-Sync-Code",
      "Vary": "Origin",
    };

    // ブラウザの事前確認(プリフライト)
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // 合言葉トークン（APP_TOKEN を設定したときだけ有効。未設定なら素通し）
    if (env.APP_TOKEN && request.headers.get("X-App-Token") !== env.APP_TOKEN) {
      return reply({ error: { message: "許可されていないアクセスです（合言葉が違います）" } }, 403, cors);
    }

    // レート制限（RATE_LIMITER バインディングを追加したときだけ有効。無ければ素通し）
    // IPごとに一定回数を超えたら 429 で止める。ダッシュボードで上限/期間を設定する。
    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return reply({ error: { message: "アクセスが集中しています。1分ほど待って再度お試しください。" } }, 429, cors);
      }
    }

    const url = new URL(request.url);
    // 学習アプリ → スマホの学習メモへ「今日の動画」を受け渡す
    if (url.pathname === "/sync/state") return handleSync(request, env, cors);

    if (url.pathname !== "/yt") return reply({ error: { message: "Not found" } }, 404, cors);

    const path = url.searchParams.get("path") || "";
    const endpoint = path.split("?")[0];
    if (!ALLOWED_ENDPOINTS.has(endpoint)) {
      return reply({ error: { message: "許可されていないエンドポイントです: " + endpoint } }, 400, cors);
    }
    if (!env.YOUTUBE_API_KEY) {
      return reply({ error: { message: "サーバーにAPIキー(YOUTUBE_API_KEY)が設定されていません" } }, 500, cors);
    }

    // キャッシュのキーはキーを含めない（pathだけ）。キーはYouTubeへ送るときだけ付ける。
    const cache = caches.default;
    const cacheKey = new Request(new URL("/cache?p=" + encodeURIComponent(path), url.origin));
    let bodyText, status;

    const hit = await cache.match(cacheKey);
    if (hit) {
      bodyText = await hit.text();
      status = hit.status;
    } else {
      const target = `https://www.googleapis.com/youtube/v3/${path}&key=${env.YOUTUBE_API_KEY}`;
      const upstream = await fetch(target);
      bodyText = await upstream.text();
      status = upstream.status;
      if (status === 200) {
        const toCache = new Response(bodyText, {
          status,
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=21600" },
        });
        // 待たずにキャッシュへ（レスポンスは先に返す）
        ctx.waitUntil(cache.put(cacheKey, toCache));
      }
    }
    return reply(bodyText, status, cors, true);
  },
};

// 連携データの保存・取得（KV バインディング SYNC を使う）
// 連携コードそのものは保存せず、SHA-256 にしたものを KV のキーにする。
async function handleSync(request, env, cors) {
  if (!env.SYNC) return reply({ error: { message: "連携用の保存場所(SYNC)が設定されていません" } }, 503, cors);
  const code = request.headers.get("X-Sync-Code") || "";
  if (code.length < 16) return reply({ error: { message: "連携コードが正しくありません" } }, 400, cors);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  const key = "state:" + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");

  if (request.method === "GET") {
    const saved = await env.SYNC.get(key);
    if (saved === null) return reply({ error: { message: "まだ連携データがありません" } }, 404, cors);
    return reply(saved, 200, cors, true);
  }
  if (request.method === "PUT") {
    const body = await request.text();
    if (body.length > 8192) return reply({ error: { message: "データが大きすぎます" } }, 413, cors);
    try { JSON.parse(body); } catch { return reply({ error: { message: "JSONとして読めません" } }, 400, cors); }
    await env.SYNC.put(key, body);
    return reply({ ok: true }, 200, cors);
  }
  return reply({ error: { message: "使えない操作です" } }, 405, cors);
}

function reply(body, status, cors, raw) {
  return new Response(raw ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
