// Discord に /purge コマンドを登録する。
//   npm run register              全サーバーに登録（反映に少し時間がかかることがある）
//   npm run register -- <サーバーID>  そのサーバーだけに即時登録（動作確認向け）
//
// DISCORD_BOT_TOKEN は環境変数、または cloudflare/.dev.vars から読む。
import { existsSync } from "node:fs";

if (existsSync(".dev.vars")) process.loadEnvFile(".dev.vars");

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("DISCORD_BOT_TOKEN が未設定です");
  process.exit(1);
}

const API = "https://discord.com/api/v10";
const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };

const command = {
  name: "purge",
  description: "カテゴリ内のテキストチャンネルを一括削除します",
  default_member_permissions: String(1 << 4), // チャンネルの管理
  contexts: [0], // サーバー内のみ
  options: [
    {
      type: 7, // チャンネル
      name: "category",
      name_localizations: { ja: "カテゴリ" },
      description: "対象のカテゴリ",
      channel_types: [4],
      required: true,
    },
    {
      type: 10, // 数値
      name: "inactive_days",
      name_localizations: { ja: "放置日数" },
      description: "最後の投稿からこの日数以上経ったチャンネルだけを対象にする",
      min_value: 0,
    },
    {
      type: 3, // 文字列
      name: "exclude",
      name_localizations: { ja: "除外" },
      description: "残すチャンネルの名前または ID（スペース・カンマ区切りで複数可）",
    },
  ],
};

const app = await request("GET", "/applications/@me");
const guildId = process.argv[2];
const path = guildId
  ? `/applications/${app.id}/guilds/${guildId}/commands`
  : `/applications/${app.id}/commands`;
await request("PUT", path, [command]);

console.log(`/purge を${guildId ? `サーバー ${guildId} に` : "全サーバー向けに"}登録しました（${app.name}）`);
console.log(`DISCORD_PUBLIC_KEY: ${app.verify_key}`);

async function request(method, path, body) {
  const res = await fetch(API + path, { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${method} ${path} -> ${res.status}`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}
