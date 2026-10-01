import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const publicKeyHex = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
const env = { DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_BOT_TOKEN: "test-token" };

const MANAGE = String(1 << 4);
const CATEGORY = "100";
// 2015-01-01 ごろの snowflake（古い）と現在時刻の snowflake
const OLD_ID = String(1n << 22n);
const nowId = () => String(BigInt(Date.now() - 1420070400000) << 22n);

let channels;
let guild;
let calls;
let waits;

beforeEach(() => {
  channels = [
    { id: CATEGORY, type: 4, name: "cat", position: 0 },
    { id: "201", type: 0, name: "a", parent_id: CATEGORY, position: 1, last_message_id: OLD_ID },
    { id: "202", type: 0, name: "b", parent_id: CATEGORY, position: 2, last_message_id: nowId() },
    { id: "203", type: 2, name: "voice", parent_id: CATEGORY, position: 3 },
    { id: "204", type: 0, name: "other-cat", parent_id: "999", position: 4 },
    { id: "205", type: 5, name: "news", parent_id: CATEGORY, position: 5, last_message_id: OLD_ID },
  ];
  guild = {
    id: "1",
    owner_id: "owner",
    roles: [
      { id: "1", permissions: String(1 << 10) }, // @everyone: チャンネルを見る
      { id: "mod", permissions: MANAGE },
    ],
  };
  calls = [];
  waits = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body && JSON.parse(init.body), headers: init.headers });
    if (url.endsWith("/guilds/1/channels")) return Response.json(channels);
    if (url.endsWith("/guilds/1")) return Response.json(guild);
    if (init.method === "DELETE") {
      const id = url.split("/").pop();
      channels = channels.filter((c) => c.id !== id);
      return new Response(null, { status: 204 });
    }
    if (init.method === "PATCH") return Response.json({});
    return new Response("not found", { status: 404 });
  };
});

const ctx = { waitUntil: (p) => waits.push(p) };
const settle = () => Promise.all(waits);

async function signed(payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(timestamp + body));
  return new Request("https://worker.example/", {
    method: "POST",
    body,
    headers: { "X-Signature-Ed25519": Buffer.from(sig).toString("hex"), "X-Signature-Timestamp": timestamp },
  });
}

const moderator = { permissions: MANAGE, roles: ["mod"], user: { id: "u1", username: "tester" } };

function command(options, member = moderator) {
  return {
    type: 2,
    application_id: "app",
    token: "tok",
    guild_id: "1",
    member,
    data: { name: "purge", options, resolved: { channels: { [CATEGORY]: { name: "cat" } } } },
  };
}

const lastEdit = () => calls.filter((c) => c.method === "PATCH").at(-1).body;

test("署名が不正なら 401", async () => {
  const req = await signed({ type: 1 });
  const tampered = new Request(req, { body: JSON.stringify({ type: 1, x: 1 }) });
  const res = await worker.fetch(tampered, env, ctx);
  assert.equal(res.status, 401);
});

test("PING に PONG を返す", async () => {
  const res = await worker.fetch(await signed({ type: 1 }), env, ctx);
  assert.deepEqual(await res.json(), { type: 1 });
});

test("権限がなければ拒否する", async () => {
  const res = await worker.fetch(await signed(command([{ name: "category", value: CATEGORY }], { ...moderator, permissions: "0" })), env, ctx);
  const body = await res.json();
  assert.match(body.data.content, /権限/);
  assert.equal(waits.length, 0);
});

test("プレビューはカテゴリ内のテキスト系チャンネルだけを列挙する", async () => {
  const res = await worker.fetch(await signed(command([{ name: "category", value: CATEGORY }])), env, ctx);
  assert.equal((await res.json()).type, 5);
  await settle();
  const edit = lastEdit();
  assert.match(edit.content, /3 件/);
  const ids = [...edit.embeds[0].description.matchAll(/<#(\d+)>/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["201", "202", "205"]);
  assert.equal(edit.components[0].components[0].custom_id, `purge:confirm:${CATEGORY}`);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0, "プレビューでは削除しない");
});

test("放置日数と除外で絞り込む", async () => {
  const opts = [
    { name: "category", value: CATEGORY },
    { name: "inactive_days", value: 30 },
    { name: "exclude", value: "news, 999" },
  ];
  await worker.fetch(await signed(command(opts)), env, ctx);
  await settle();
  const ids = [...lastEdit().embeds[0].description.matchAll(/<#(\d+)>/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["201"]);
});

test("対象がなければボタンを出さない", async () => {
  await worker.fetch(await signed(command([{ name: "category", value: "555" }])), env, ctx);
  await settle();
  assert.match(lastEdit().content, /ありません/);
  assert.equal(lastEdit().components, undefined);
});

test("確定するとプレビューに出たチャンネルだけを削除する", async () => {
  const click = {
    type: 3,
    application_id: "app",
    token: "tok",
    guild_id: "1",
    member: moderator,
    data: { custom_id: `purge:confirm:${CATEGORY}` },
    // 204 は別カテゴリなので、プレビューに紛れていても消さない
    message: { embeds: [{ description: "<#201> x\n<#204> y\n<#205> z" }] },
  };
  // プレビュー後に作られたチャンネルは消さない
  channels.push({ id: "206", type: 0, name: "new", parent_id: CATEGORY, position: 6 });

  const res = await worker.fetch(await signed(click), env, ctx);
  assert.equal((await res.json()).type, 7);
  await settle();

  const deleted = calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").pop());
  assert.deepEqual(deleted, ["201", "205"]);
  assert.equal(calls.find((c) => c.method === "DELETE").headers["X-Audit-Log-Reason"], encodeURIComponent("/purge by tester"));
  assert.match(lastEdit().content, /2 件削除/);
  assert.deepEqual(lastEdit().components, []);
});

test("キャンセルでボタンを消す", async () => {
  const click = {
    type: 3,
    member: moderator,
    data: { custom_id: "purge:cancel" },
  };
  const body = await (await worker.fetch(await signed(click), env, ctx)).json();
  assert.equal(body.type, 7);
  assert.deepEqual(body.data.components, []);
});

test("Discord API のエラーはメッセージで知らせる", async () => {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body && JSON.parse(init.body) });
    if (init.method === "PATCH") return Response.json({});
    return Response.json({ message: "Missing Access" }, { status: 403 });
  };
  await worker.fetch(await signed(command([{ name: "category", value: CATEGORY }])), env, ctx);
  await settle();
  assert.match(lastEdit().content, /403 Missing Access/);
});

const previewIds = () => [...(lastEdit().embeds?.[0]?.description ?? "").matchAll(/<#(\d+)>/g)].map((m) => m[1]);

test("実行チャンネルでだけ管理権限を持つ人は、カテゴリ内のチャンネルを対象にできない", async () => {
  // ロールに管理権限はなく、実行したチャンネルの上書きでだけ権限を持っている
  const member = { permissions: MANAGE, roles: [], user: { id: "u2", username: "sneaky" } };
  await worker.fetch(await signed(command([{ name: "category", value: CATEGORY }], member)), env, ctx);
  await settle();
  assert.deepEqual(previewIds(), []);
  assert.match(lastEdit().content, /管理権限がないため対象外: 3 件/);
});

test("チャンネルの権限上書きで管理権限を外されたチャンネルは対象外", async () => {
  channels.find((c) => c.id === "202").permission_overwrites = [
    { id: "mod", type: 0, allow: "0", deny: MANAGE },
  ];
  await worker.fetch(await signed(command([{ name: "category", value: CATEGORY }])), env, ctx);
  await settle();
  assert.deepEqual(previewIds(), ["201", "205"]);
  assert.match(lastEdit().content, /対象外: 1 件/);
});

test("見えないチャンネルは対象外、個別に許可されたチャンネルは対象", async () => {
  const member = { permissions: MANAGE, roles: [], user: { id: "u3", username: "helper" } };
  channels.find((c) => c.id === "201").permission_overwrites = [
    { id: "u3", type: 1, allow: MANAGE, deny: "0" },
  ];
  channels.find((c) => c.id === "205").permission_overwrites = [
    { id: "1", type: 0, allow: "0", deny: String(1 << 10) },
    { id: "u3", type: 1, allow: MANAGE, deny: "0" },
  ];
  await worker.fetch(await signed(command([{ name: "category", value: CATEGORY }], member)), env, ctx);
  await settle();
  assert.deepEqual(previewIds(), ["201"]);
});

test("サーバー所有者と管理者はすべて対象にできる", async () => {
  channels.find((c) => c.id === "202").permission_overwrites = [
    { id: "1", type: 0, allow: "0", deny: String((1 << 10) | (1 << 4)) },
  ];
  const owner = { permissions: MANAGE, roles: [], user: { id: "owner", username: "owner" } };
  await worker.fetch(await signed(command([{ name: "category", value: CATEGORY }], owner)), env, ctx);
  await settle();
  assert.deepEqual(previewIds(), ["201", "202", "205"]);

  guild.roles.push({ id: "admin", permissions: String(1 << 3) });
  const admin = { permissions: MANAGE, roles: ["admin"], user: { id: "u4", username: "admin" } };
  await worker.fetch(await signed(command([{ name: "category", value: CATEGORY }], admin)), env, ctx);
  await settle();
  assert.deepEqual(previewIds(), ["201", "202", "205"]);
});

test("確定時にも権限を確認し直す", async () => {
  const member = { permissions: MANAGE, roles: [], user: { id: "u2", username: "sneaky" } };
  const click = {
    type: 3,
    application_id: "app",
    token: "tok",
    guild_id: "1",
    member,
    data: { custom_id: `purge:confirm:${CATEGORY}` },
    message: { embeds: [{ description: "<#201> x\n<#205> z" }] },
  };
  await worker.fetch(await signed(click), env, ctx);
  await settle();
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  assert.match(lastEdit().content, /0 件削除/);
});
