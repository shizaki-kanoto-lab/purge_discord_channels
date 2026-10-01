/**
 * Discord の /purge コマンドを処理する Cloudflare Worker。
 *
 * 流れ:
 *   /purge → 削除対象をプレビュー（実行者にだけ見える）
 *   「削除する」ボタン → プレビューに出したチャンネルだけを削除
 */
const API = "https://discord.com/api/v10";
const ADMINISTRATOR = 1n << 3n;
const MANAGE_CHANNELS = 1n << 4n;
const VIEW_CHANNEL = 1n << 10n;
const ALL_PERMISSIONS = (1n << 64n) - 1n;
const TEXT_CHANNEL_TYPES = new Set([0, 5]); // 0: テキスト, 5: アナウンス
const DISCORD_EPOCH_MS = 1420070400000n;
const EPHEMERAL = 1 << 6;

// Workers 無料プランは 1 リクエストあたり外部通信 50 回まで。取得・編集・リトライ分を残しておく。
const MAX_DELETES_PER_RUN = 35;
// ボタン応答後に処理できる時間（約 30 秒）に収める。
const TIME_BUDGET_MS = 20_000;

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 };
const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4, DEFERRED_CHANNEL_MESSAGE: 5, UPDATE_MESSAGE: 7 };

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("purge-discord-channels is running");

    const body = await request.text();
    if (!(await verifySignature(request, body, env.DISCORD_PUBLIC_KEY))) {
      return new Response("invalid request signature", { status: 401 });
    }
    const interaction = JSON.parse(body);

    if (interaction.type === InteractionType.PING) {
      return json({ type: ResponseType.PONG });
    }
    if (!hasManageChannels(interaction)) {
      return ephemeral("このコマンドには「チャンネルの管理」権限が必要です。");
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data.name === "purge") {
      ctx.waitUntil(handlePurge(interaction, env));
      return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } });
    }

    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      const [ns, action, categoryId] = interaction.data.custom_id.split(":");
      if (ns === "purge" && action === "cancel") {
        return json({
          type: ResponseType.UPDATE_MESSAGE,
          data: { content: "キャンセルしました。", embeds: [], components: [] },
        });
      }
      if (ns === "purge" && action === "confirm") {
        ctx.waitUntil(handleConfirm(interaction, env, categoryId));
        return json({
          type: ResponseType.UPDATE_MESSAGE,
          data: { content: "削除しています…", components: [] },
        });
      }
    }

    return ephemeral("不明な操作です。");
  },
};

async function handlePurge(interaction, env) {
  try {
    const opts = Object.fromEntries((interaction.data.options ?? []).map((o) => [o.name, o.value]));
    const categoryId = opts.category;
    const categoryName = interaction.data.resolved?.channels?.[categoryId]?.name ?? categoryId;
    const exclude = parseExclude(opts.exclude);
    const inactiveDays = opts.inactive_days;

    const { allowed, forbidden } = await loadCandidates(interaction, env, categoryId);
    const cutoff = inactiveDays == null ? null : Date.now() - inactiveDays * 86_400_000;
    const targets = allowed
      .filter((c) => !exclude.has(c.id) && !exclude.has(c.name))
      .filter((c) => cutoff == null || lastActivity(c) <= cutoff)
      .sort((a, b) => a.position - b.position);

    const conditions = [
      inactiveDays != null && `最後の投稿から ${inactiveDays} 日以上`,
      exclude.size > 0 && `除外: ${[...exclude].join(", ")}`,
    ].filter(Boolean);
    const forbiddenNote = forbidden.length
      ? `\n-# あなたに管理権限がないため対象外: ${forbidden.length} 件`
      : "";

    if (targets.length === 0) {
      await editOriginal(interaction, {
        content: `カテゴリ「${categoryName}」に削除対象のテキストチャンネルはありません。` + forbiddenNote,
      });
      return;
    }

    await editOriginal(interaction, {
      content:
        `カテゴリ「**${categoryName}**」の削除対象: **${targets.length} 件**` +
        (conditions.length ? `\n条件: ${conditions.join(" / ")}` : "") +
        forbiddenNote +
        "\n-# 削除したチャンネルは元に戻せません。",
      embeds: [targetEmbed(targets)],
      components: [confirmButtons(categoryId, "削除する")],
    });
  } catch (e) {
    console.error("purge failed:", e.message);
    await editOriginal(interaction, { content: `エラー: ${e.message}` }).catch((e2) => console.error(e2.message));
  }
}

async function handleConfirm(interaction, env, categoryId) {
  try {
    // プレビューに表示したチャンネルだけを対象にする（表示後に作られたものは消さない）
    const previewIds = [
      ...(interaction.message.embeds?.[0]?.description ?? "").matchAll(/<#(\d+)>/g),
    ].map((m) => m[1]);

    // 今もそのカテゴリ内にあり、実行者が管理権限を持つチャンネルだけに絞る
    const { allowed } = await loadCandidates(interaction, env, categoryId);
    const current = new Map(allowed.map((c) => [c.id, c]));
    const queue = previewIds.map((id) => current.get(id)).filter(Boolean);

    const reason = `/purge by ${interaction.member.user.username}`;
    const started = Date.now();
    const deleted = [];
    const failed = [];
    let processed = 0;
    for (const channel of queue) {
      if (processed >= MAX_DELETES_PER_RUN || Date.now() - started > TIME_BUDGET_MS) break;
      processed++;
      try {
        await discord(env, "DELETE", `/channels/${channel.id}`, reason);
        deleted.push(channel);
      } catch (e) {
        failed.push({ channel, error: e.message });
      }
    }
    const remaining = queue.slice(processed);

    const lines = [`**${deleted.length} 件削除しました。**`];
    if (deleted.length) lines.push(deleted.map((c) => `#${c.name}`).join(", "));
    if (failed.length) {
      lines.push(`\n**${failed.length} 件失敗:**`);
      lines.push(...failed.map((f) => `#${f.channel.name}: ${f.error}`));
    }
    if (remaining.length) lines.push(`\n残り **${remaining.length} 件**。続けて削除するにはボタンを押してください。`);

    await editOriginal(interaction, {
      content: truncate(lines.join("\n"), 2000),
      embeds: remaining.length ? [targetEmbed(remaining)] : [],
      components: remaining.length ? [confirmButtons(categoryId, "続きを削除")] : [],
    });
  } catch (e) {
    console.error("confirm failed:", e.message);
    await editOriginal(interaction, { content: `エラー: ${e.message}`, embeds: [], components: [] }).catch((e2) =>
      console.error(e2.message),
    );
  }
}

/**
 * カテゴリ内のテキスト系チャンネルを、実行者が「チャンネルを見る」と「チャンネルの管理」を
 * 持つもの (allowed) と持たないもの (forbidden) に分ける。
 * interaction.member.permissions はコマンドを実行したチャンネルでの権限なので、
 * 対象チャンネルごとに権限を計算し直す。
 */
async function loadCandidates(interaction, env, categoryId) {
  const [guild, channels] = await Promise.all([
    discord(env, "GET", `/guilds/${interaction.guild_id}`),
    discord(env, "GET", `/guilds/${interaction.guild_id}/channels`),
  ]);
  const required = VIEW_CHANNEL | MANAGE_CHANNELS;
  const allowed = [];
  const forbidden = [];
  for (const channel of channels) {
    if (channel.parent_id !== categoryId || !TEXT_CHANNEL_TYPES.has(channel.type)) continue;
    const perms = memberPermissions(guild, interaction.member, channel);
    ((perms & required) === required ? allowed : forbidden).push(channel);
  }
  return { allowed, forbidden };
}

// https://discord.com/developers/docs/topics/permissions#permission-overwrites
function memberPermissions(guild, member, channel) {
  const userId = member.user.id;
  if (guild.owner_id === userId) return ALL_PERMISSIONS;

  const roles = new Map(guild.roles.map((r) => [r.id, BigInt(r.permissions)]));
  const memberRoles = new Set(member.roles ?? []);
  let perms = roles.get(guild.id) ?? 0n; // @everyone
  for (const id of memberRoles) perms |= roles.get(id) ?? 0n;
  if (perms & ADMINISTRATOR) return ALL_PERMISSIONS;

  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((o) => o.id === guild.id);
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && memberRoles.has(o.id)) {
      roleAllow |= BigInt(o.allow);
      roleDeny |= BigInt(o.deny);
    }
  }
  perms = (perms & ~roleDeny) | roleAllow;

  const own = overwrites.find((o) => o.type === 1 && o.id === userId);
  if (own) perms = (perms & ~BigInt(own.deny)) | BigInt(own.allow);
  return perms;
}

function targetEmbed(channels) {
  return {
    color: 0xed4245,
    description: channels
      .map((c) => `<#${c.id}>　最終活動 <t:${Math.floor(lastActivity(c) / 1000)}:d>`)
      .join("\n"),
  };
}

function confirmButtons(categoryId, label) {
  return {
    type: 1,
    components: [
      { type: 2, style: 4, label, custom_id: `purge:confirm:${categoryId}` },
      { type: 2, style: 2, label: "キャンセル", custom_id: "purge:cancel" },
    ],
  };
}

function parseExclude(value) {
  if (!value) return new Set();
  return new Set(
    value
      .split(/[\s,、]+/)
      .map((s) => s.replace(/^<#(\d+)>$/, "$1").replace(/^#/, ""))
      .filter(Boolean),
  );
}

function lastActivity(channel) {
  return snowflakeTime(channel.last_message_id ?? channel.id);
}

function snowflakeTime(snowflake) {
  return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS);
}

function hasManageChannels(interaction) {
  const permissions = interaction.member?.permissions;
  return permissions != null && (BigInt(permissions) & MANAGE_CHANNELS) === MANAGE_CHANNELS;
}

async function discord(env, method, path, auditReason) {
  const headers = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` };
  if (auditReason) headers["X-Audit-Log-Reason"] = encodeURIComponent(auditReason);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API + path, { method, headers });
    if (res.status === 429) {
      const { retry_after = 1 } = await res.json().catch(() => ({}));
      console.warn(`rate limited: ${method} ${path} retry_after=${retry_after}`);
      await new Promise((r) => setTimeout(r, retry_after * 1000 + 100));
      continue;
    }
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(`${res.status} ${detail.message ?? res.statusText}`);
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error("レート制限のため中断しました");
}

async function editOriginal(interaction, data) {
  const url = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`メッセージ更新に失敗: ${res.status} ${await res.text()}`);
}

async function verifySignature(request, body, publicKey) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKey) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("invalid hex");
  return Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
}

function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function json(data) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

function ephemeral(content) {
  return json({ type: ResponseType.CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL } });
}
