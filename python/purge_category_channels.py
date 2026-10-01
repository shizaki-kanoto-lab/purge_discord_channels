#!/usr/bin/env python3
"""Discord の特定カテゴリ配下にあるテキストチャンネルを削除するツール。

デフォルトはドライラン（削除対象を表示するだけ）。--yes を付けたときだけ実際に削除する。

必要な環境変数（または同じディレクトリの .env）:
  DISCORD_BOT_TOKEN  Bot トークン
  DISCORD_GUILD_ID   サーバー ID
  DISCORD_CATEGORY_ID  対象カテゴリ ID（--category で上書き可）
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://discord.com/api/v10"
DISCORD_EPOCH_MS = 1420070400000
TEXT_CHANNEL_TYPES = {0, 5}  # 0: テキスト, 5: アナウンス


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def snowflake_time(snowflake: str) -> datetime:
    ms = (int(snowflake) >> 22) + DISCORD_EPOCH_MS
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def request(method: str, path: str, token: str, reason: str | None = None):
    headers = {
        "Authorization": f"Bot {token}",
        "User-Agent": "DiscordBot (purge-category-channels, 1.0)",
    }
    if reason:
        headers["X-Audit-Log-Reason"] = urllib.request.quote(reason)
    while True:
        req = urllib.request.Request(API + path, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as res:
                body = res.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as e:
            if e.code == 429:  # レート制限: 指定秒数待って再試行
                retry = json.loads(e.read() or b"{}").get("retry_after", 1)
                print(f"  レート制限中… {retry:.1f}秒待機")
                time.sleep(float(retry) + 0.1)
                continue
            detail = e.read().decode(errors="replace")
            raise RuntimeError(f"{method} {path} -> {e.code}: {detail}") from None


def main() -> int:
    load_dotenv(Path(__file__).with_name(".env"))

    p = argparse.ArgumentParser(description="カテゴリ内のテキストチャンネルを一括削除")
    p.add_argument("--category", default=os.environ.get("DISCORD_CATEGORY_ID"),
                   help="対象カテゴリ ID")
    p.add_argument("--yes", action="store_true", help="実際に削除する（無指定ならドライラン）")
    p.add_argument("--exclude", nargs="*", default=[],
                   help="削除しないチャンネル名または ID")
    p.add_argument("--inactive-days", type=float,
                   help="最後の投稿（投稿なしなら作成）からこの日数以上経ったものだけ削除")
    args = p.parse_args()

    token = os.environ.get("DISCORD_BOT_TOKEN")
    guild_id = os.environ.get("DISCORD_GUILD_ID")
    missing = [n for n, v in [("DISCORD_BOT_TOKEN", token), ("DISCORD_GUILD_ID", guild_id),
                              ("DISCORD_CATEGORY_ID / --category", args.category)] if not v]
    if missing:
        print("未設定: " + ", ".join(missing), file=sys.stderr)
        return 2

    channels = request("GET", f"/guilds/{guild_id}/channels", token)
    category = next((c for c in channels if c["id"] == args.category), None)
    if category is None or category["type"] != 4:
        print(f"カテゴリ {args.category} が見つかりません", file=sys.stderr)
        return 1

    excluded = set(args.exclude)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=args.inactive_days)
              if args.inactive_days is not None else None)

    targets = []
    for c in sorted(channels, key=lambda c: c.get("position", 0)):
        if c.get("parent_id") != args.category or c["type"] not in TEXT_CHANNEL_TYPES:
            continue
        if c["id"] in excluded or c["name"] in excluded:
            continue
        last_active = snowflake_time(c.get("last_message_id") or c["id"])
        if cutoff and last_active > cutoff:
            continue
        targets.append((c, last_active))

    print(f"カテゴリ「{category['name']}」: 削除対象 {len(targets)} 件")
    for c, last_active in targets:
        print(f"  #{c['name']} ({c['id']})  最終活動 {last_active.astimezone():%Y-%m-%d %H:%M}")

    if not targets:
        return 0
    if not args.yes:
        print("\nドライランです。削除するには --yes を付けて実行してください。")
        return 0

    failed = 0
    for c, _ in targets:
        try:
            request("DELETE", f"/channels/{c['id']}", token, reason="purge_category_channels")
            print(f"  削除: #{c['name']}")
        except RuntimeError as e:
            failed += 1
            print(f"  失敗: #{c['name']} - {e}", file=sys.stderr)
    print(f"完了: {len(targets) - failed} 件削除, {failed} 件失敗")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
