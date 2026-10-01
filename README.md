# purge_discord_channels

Discord の特定カテゴリ配下にあるテキストチャンネルを一括削除するツールです。

> [!WARNING]
> 削除したチャンネルは元に戻せません。どちらの版も、削除前に対象の一覧を確認できるようになっています。

## 2 つの版

| | [Cloudflare 版](cloudflare/) | [Python 版](python/) |
|---|---|---|
| 使い方 | Discord 上で `/purge` コマンドを実行 | 手元の PC からコマンドで実行 |
| 動かす場所 | Cloudflare Workers（無料プランで可） | 自分の PC |
| 必要なもの | Node.js、Cloudflare アカウント | Python 3.10 以上 |
| 向いている用途 | サーバーの管理者が Discord から気軽に使う | 定期実行（cron）や一度きりの整理 |

共通の動作:

- 対象はカテゴリ直下のテキスト・アナウンスチャンネルのみ（ボイス・フォーラムチャンネルとカテゴリ自体は残す）
- 除外指定、最後の投稿からの経過日数での絞り込みに対応
- レート制限時は自動で待機して再試行

## 共通の準備: Discord Bot を作る

どちらの版でも、まず自分の Discord Bot を作ってサーバーに招待します。

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application** を作成
2. **Bot** タブで **Reset Token** を押してトークンを取得（他人に見せない・公開しない）
3. **OAuth2 → URL Generator** で Scopes に `bot`、Bot Permissions に `View Channels` と `Manage Channels` を選択
4. 生成された URL を開き、対象サーバーに招待

非公開カテゴリを対象にする場合は、カテゴリの権限設定で Bot のロールに上記 2 権限を許可してください。

### ID の調べ方

Discord の **ユーザー設定 → 詳細設定 → 開発者モード** をオンにすると、右クリックメニューから ID をコピーできます。

- サーバー ID: サーバーアイコンを右クリック → **サーバーIDをコピー**
- カテゴリ ID: カテゴリ名を右クリック → **カテゴリーIDをコピー**

続きは各版の README を参照してください。

- [Cloudflare 版の設置手順](cloudflare/README.md)
- [Python 版の使い方](python/README.md)

## ライセンス

[MIT](LICENSE)
