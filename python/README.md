# Python 版

手元の PC からコマンドで実行するスクリプトです。Python 標準ライブラリだけで動作し、追加インストールは不要です。

## 特徴

- デフォルトはドライラン（対象を表示するだけ）。`--yes` を付けたときだけ削除
- 除外指定（`--exclude`）、非アクティブ日数での絞り込み（`--inactive-days`）

## 必要なもの

- Python 3.10 以上
- Discord Bot（[作り方](../README.md#共通の準備-discord-bot-を作る)）

## セットアップ

このディレクトリで設定ファイルを作ります。

```bash
cd python
cp .env.example .env
```

`.env` に値を記入します（[ID の調べ方](../README.md#id-の調べ方)）。

```
DISCORD_BOT_TOKEN=Botトークン
DISCORD_GUILD_ID=サーバーID
DISCORD_CATEGORY_ID=カテゴリID
```

`.env` にはトークンが含まれるため、絶対に公開・コミットしないでください（`.gitignore` で除外済み）。

## 使い方

```bash
# 削除対象を確認（何も消えない）
python3 purge_category_channels.py

# 実際に削除
python3 purge_category_channels.py --yes

# 特定のチャンネルを残す（名前または ID）
python3 purge_category_channels.py --yes --exclude ルール 1234567890

# 最後の投稿から 30 日以上経ったものだけ削除
python3 purge_category_channels.py --yes --inactive-days 30

# .env と別のカテゴリを指定
python3 purge_category_channels.py --category 1234567890
```

## 定期実行（macOS / Linux）

`crontab -e` に追加すると毎日 4 時に実行されます。

```
0 4 * * * /usr/bin/python3 /path/to/python/purge_category_channels.py --yes --inactive-days 7
```
