# Cloudflare 版（Discord スラッシュコマンド）

Discord 上で `/purge` コマンドを使えるようにする Cloudflare Worker です。Workers の無料プランで運用できます。

## 使い方

1. `/purge カテゴリ:<カテゴリを選択>` を実行
2. 削除対象の一覧と「削除する」「キャンセル」ボタンが表示される（実行者にだけ見える）
3. 「削除する」を押すと、一覧に表示されたチャンネルだけが削除される

オプション:

| オプション | 内容 |
|---|---|
| `カテゴリ`（必須） | 対象カテゴリ。候補から選べる |
| `放置日数` | 最後の投稿からこの日数以上経ったチャンネルだけを対象にする |
| `除外` | 残すチャンネルの名前または ID（スペース・カンマ区切り） |

コマンドは「チャンネルの管理」権限を持つメンバーにだけ表示されます。削除対象になるのは、実行したメンバー自身が「チャンネルを見る」「チャンネルの管理」の両方を持っているチャンネルだけです（チャンネルごとの権限設定も考慮します）。削除は監査ログに `/purge by <実行者>` として記録されます。

## 必要なもの

- [Node.js](https://nodejs.org/) 20 以上
- [Cloudflare](https://dash.cloudflare.com/sign-up) アカウント（無料プランで可）
- Discord Bot（[作り方](../README.md#共通の準備-discord-bot-を作る)）

## 設置手順

```bash
cd cloudflare
npm install
```

### 1. Cloudflare にデプロイする

```bash
npx wrangler login
npx wrangler deploy
```

表示された `https://purge-discord-channels.<あなたのサブドメイン>.workers.dev` を控えておきます。

### 2. シークレットを設定する

Developer Portal の **General Information** にある **Public Key** と、Bot トークンを登録します。

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

### 3. Discord にエンドポイントを登録する

Developer Portal の **General Information → Interactions Endpoint URL** に手順 1 の URL を入力して保存します。保存時に Discord が疎通確認を行い、成功すれば保存されます。

### 4. コマンドを登録する

このディレクトリに `.dev.vars` を作り、`DISCORD_BOT_TOKEN=Botトークン` と書いてから実行します（`.gitignore` で除外済み）。

```bash
# 全サーバー向け
npm run register

# 特定サーバーにだけ即時登録（動作確認向け）
npm run register -- <サーバーID>
```

登録が済んだら `.dev.vars` は削除してかまいません。トークンは Cloudflare のシークレットに保存されているので、Worker の動作には影響しません。

## 制限

Workers 無料プランの制限に合わせ、1 回のボタン操作で削除するのは最大 35 件です。残りがある場合は「続きを削除」ボタンが表示されます。

## テスト

Discord や Cloudflare に接続せず、手元で動作を確認できます。

```bash
npm test
```

## トラブルシューティング

Worker のログをリアルタイムで確認できます。

```bash
npx wrangler tail
```
