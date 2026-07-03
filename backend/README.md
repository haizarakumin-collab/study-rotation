# バックエンド（YouTube API プロキシ）

使う人がAPIキーを設定しなくて済むように、**あなたのキーを1個だけサーバーに隠して**
YouTube Data API を中継する小さなプログラム（Cloudflare Worker）。

- `worker.js` … 中継の本体
- `wrangler.toml` … CLIでデプロイするとき用の設定

## しくみ

```
ユーザーのブラウザ（github.io の画面）
   → あなたのWorker（/yt?path=...）  ← ここで秘密のキーを付ける
      → YouTube Data API
```

キーは Worker の「環境変数(Secret) `YOUTUBE_API_KEY`」に入れる。コードやフロントには出ない。

## デプロイ手順（管理画面・CLI不要）

1. https://dash.cloudflare.com で無料アカウントを作ってログイン。
2. 左メニュー「**Workers & Pages**」→「**Create**」→「**Create Worker**」。
3. 名前を `study-rotation-api` などにして「**Deploy**」（中身は後で差し替える）。
4. 「**Edit code**」を開き、既定のコードを全部消して `worker.js` の中身を貼り付け →「**Deploy**」。
5. Worker の「**Settings**」→「**Variables and Secrets**」→「**Add**」:
   - 種類: **Secret**（暗号化）
   - 名前: `YOUTUBE_API_KEY`
   - 値: あなたの YouTube Data API キー（`AIza…`）
   - 保存して「Deploy」。
6. Worker のURL（`https://study-rotation-api.〇〇.workers.dev`）を控える。
   - 動作確認: ブラウザで `そのURL/yt?path=channels%3Fpart%3Did%26id%3DUC_x5XG1OV2P6uZZ5FSM9Ttw`
     を開き、JSONが返ればOK（キー漏れなし）。

## フロントとつなぐ

`index.html` の `const API_BASE = "";` を、上のWorkerのURLに変える。例:

```js
const API_BASE = "https://study-rotation-api.〇〇.workers.dev";
```

変更を push すれば、数分で公開サイトに反映される。

## CLIでやる場合（任意）

```bash
npm install -g wrangler
wrangler login
cd backend
wrangler secret put YOUTUBE_API_KEY   # キーを貼る
wrangler deploy
```

## 合言葉トークン（任意・雑な直叩き対策）

Worker に Secret `APP_TOKEN` を設定すると、その合言葉を持つリクエストだけ通す。
フロント(index.html)の `APP_TOKEN` と**同じ値**にすること。

- 設定: Worker の「Settings」→「Variables and Secrets」→ Add
  - Type: **Secret** / Name: `APP_TOKEN` / Value: フロントの `APP_TOKEN` と同じ文字列
- `APP_TOKEN` を設定しなければチェックは無効（従来どおり素通し。ロックアウト事故は起きない）。
- ※フロントは公開ソースなのでトークンは読めてしまう。本物の認証ではなく、
  URLだけ見つけたbotや curl 直叩きを弾くための摩擦。本気の対策はレート制限。

## レート制限（IPごとの回数制限・本命の乱用対策）

Worker に「Rate Limiting バインディング」を追加すると、IPごとに回数制限がかかる。
コードは `env.RATE_LIMITER` があるときだけ動く（無ければ素通し。事故らない）。

- 追加: Worker の「Settings」→「Bindings」→「Add binding」→「**Rate limiting**」
  - 変数名(Variable name): `RATE_LIMITER`
  - Limit: `60` / Period: `60` 秒（＝1IPあたり60回/分）
  - 保存して「Deploy」。
- 超過すると 429 を返し、フロントは「アクセスが集中しています…」と表示する。
- チャンネル一括読み込みは短時間に十数回呼ぶので、上限は60/分程度にして連続読み込みを妨げない。

## 注意

- クォータ（1日1万ユニット）は全ユーザー共有。チャンネル名検索(search)は100ユニットと高い。
  ハンドル(@名前)やチャンネルID(UC…)のURLを使うと1ユニットで済む。
- 公開プロキシなのでURLを知られると他人にも使われ得る。合言葉トークン＋レート制限で
  実用上の乱用はかなり抑えられる。
