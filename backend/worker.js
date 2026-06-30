// 学習ローテーション用 YouTube Data API プロキシ（Cloudflare Workers）
//
// 役割: フロント（GitHub Pages の画面）からのリクエストに、秘密のAPIキーを付けて
//       YouTube Data API へ中継する。これにより、使う人はキー設定が不要になる。
//
// 大事な点:
//  - APIキーはこのコードには書かない。Cloudflare の環境変数(Secret) YOUTUBE_API_KEY に入れる。
//  - 中継先は決まったエンドポイント（playlistItems / channels / search）だけに制限。
//  - 同じ問い合わせは6時間キャッシュして、1日のAPI利用上限(クォータ)を節約する。
//  - レスポンスには、許可したオリジンだけに CORS を付けて返す。

const ALLOWED_ENDPOINTS = new Set(["playlistItems", "channels", "search"]);

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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    // ブラウザの事前確認(プリフライト)
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
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

function reply(body, status, cors, raw) {
  return new Response(raw ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
