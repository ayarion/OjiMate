# OjiMate

集中しているとき、あなたの分身であるおじさんも隣で働く。休めばおじさんも休む。
積み上げた集中時間で、ボロアパートから庭付きの家を目指すフォーカスタイマーです。

公開版: [https://tsukuriba.org/OjiMate/](https://tsukuriba.org/OjiMate/)

## 主な機能

- **モバイル・PC対応** — モバイルは3D風景を中心にした一画面、幅768px以上のPCでは3D風景と操作パネルを並べたワークベンチ表示になります。横向き・狭い画面・safe areaにも対応しています。
- **実時間タイマー** — 通常モードでは1分を実際の60秒として計測します。進行中のセッションはブラウザに保存され、タブを閉じたり再読み込みした場合も、経過時間を反映した一時停止状態で復元されます。
- **PWA・オフライン** — manifest、PNG/SVGアイコン、Service Workerを備えています。3Dランタイムもプロジェクト内に同梱し、Service Workerのインストール完了後はオフラインで再訪できます。初回起動とAI会話には通信が必要です。
- **音声はオプトイン** — 初期状態は `音 OFF` です。ユーザーが明示的にオンにした場合だけ、集中中の環境音を再生します。設定はブラウザに保存されます。
- **アクセシビリティ** — キーボード操作、見えるフォーカス、フォームラベル、状態の読み上げ、モーダル中のフォーカス管理、`prefers-reduced-motion`、WebGLを利用できない場合の操作パネルへのフォールバックを用意しています。
- **ローカル保存** — 集中時間、家の進捗、直近の記録、チュートリアル状態などは、このブラウザの `localStorage` に保存します。アカウントやクラウド同期はありません。

## ローカルで起動する

リポジトリ直下で静的HTTPサーバーを起動します。`file://` で直接開かず、`http://localhost` を利用してください。

```bash
python -m http.server 8123
```

Windowsで `python` コマンドがない場合は、次でも起動できます。

```powershell
py -m http.server 8123
```

起動後、[http://localhost:8123/](http://localhost:8123/) を開きます。現在の実装ではService Workerの登録はHTTPS配信時だけ行うため、PWA・オフライン動作は公開先などのHTTPS環境で確認してください。

## チェック

Node.jsとnpmがあれば、追加パッケージをインストールせずに構文・PWAファイル・主要な回帰条件を確認できます。

```bash
npm run check
```

## 開発用デモモード

`?demo=1` はタイマーを短時間で完了させる**開発テスト専用**のモードです。`localhost` と `127.0.0.1` でだけ有効になり、公開URLでは通常速度のままです。

```text
http://localhost:8123/?demo=1
```

デモモードの記録は通常版と別の保存領域を使い、実際の集中記録や報酬には加算しません。

WebGLなしの軽量表示は、ローカルで `?force2d=1` を付けると確認できます。こちらも公開URLでは有効になりません。

## おじさんをAIエージェントにする（任意）

未設定時のセリフはすべてブラウザ内で組み立てられ、外部へデータを送りません。AI会話を使う場合だけ、`worker/` のCloudflare Workerをデプロイします。

```bash
cd worker
npx wrangler secret put OJIMATE_SECRET
npx wrangler deploy
```

Workers AIが既定です。Anthropicへ切り替える場合だけ `ANTHROPIC_API_KEY` もCloudflareのsecretとして設定してください。APIキーをブラウザやGitへ置かないでください。`worker/index.js` の `PRODUCTION_ORIGINS` には実際にOjiMateを配信するoriginを設定します（既定は `https://tsukuriba.org`）。開発時の `http://localhost:*` と `http://127.0.0.1:*` は許可されています。Workerは `/` または `/chat` へのPOST JSONだけを受け付けます。

デプロイ後、画面内の「おじさん」の名前を長押しし、WorkerのHTTPS URLと合言葉を入力します。接続先URLは `localStorage`、合言葉はそのタブの `sessionStorage` にだけ保存され、タブを閉じると合言葉は消えます。空のURLを設定するとローカルのセリフへ戻ります。

AIを有効にすると、セリフ生成のため次の情報が設定したWorkerとAIプロバイダーへ送られます。

- 前回選んだ時間
- 直近セッションの時間と完了・中断
- 連続完了・中断回数
- おじさんとの関係段階
- 深夜帯かどうか

入力した作業内容そのもの、ブラウザ内の全履歴、CloudflareのAPIキーは送信しません。

## 構成

- `index.html` — アプリ本体とThree.jsによる3D表示
- `tokens.css` — 色・文字・余白などのデザイントークン
- `manifest.webmanifest` / `sw.js` / `icon*.png` / `icon.svg` — PWAとオフライン用ファイル
- `vendor/three.r128.min.js` — オフライン起動用に同梱したThree.js固定版
- `tests/smoke.mjs` — `npm run check` で実行するスモークチェック
- `worker/` — 任意のAI会話プロキシ
