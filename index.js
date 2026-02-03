require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
} = require("discord.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");

const DATA_FILE = process.env.DATA_FILE_PATH
  ? process.env.DATA_FILE_PATH
  : path.join(__dirname, "channel-config.json");
const POST_EVERY_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------- Helpers ----------
function getTimeOfDay(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h <= 8) return "dawn";
  if (h >= 9 && h <= 16) return "daylight";
  if (h >= 17 && h <= 20) return "dusk";
  return "night";
}

function dangerToOminousChance(level) {
  if (level === "high") return 0.4;
  if (level === "medium") return 0.2;
  return 0.08;
}

// ---------- Persistence ----------
async function loadConfig() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.channels) parsed.channels = {};
    return parsed;
  } catch {
    return { channels: {} };
  }
}

async function saveConfig(cfg) {
  await fs.writeFile(DATA_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

// ---------- OpenAI (Responses API) ----------

function trimNicely(text, maxLen = 220) {
  if (!text) return "";

  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;

  // Try to end at sentence punctuation
  const truncated = clean.slice(0, maxLen);
  const lastPunct = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("!"),
    truncated.lastIndexOf("?")
  );

  if (lastPunct > 80) {
    return truncated.slice(0, lastPunct + 1).trim();
  }

  // Otherwise end at last space
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > 80) {
    return truncated.slice(0, lastSpace).trim() + "…";
  }

  return truncated.trim() + "…";
}


async function generateAmbientMessage({
  locationName,
  lore,
  criteria,
  channelName,
  dangerLevel,
}) {
  const timeOfDay = getTimeOfDay();
  const ominousChance = dangerToOminousChance(dangerLevel);
  const tone = Math.random() < ominousChance ? "ominous" : "subtle";

  const system = [
    "You generate ONE short ambient in-world event message for a Lord of the Rings style setting.",
	"Try not to reference the same animals or situations repeatedly. Ensure variety.",
	"When describing the time of day, use different phrases to add more variety.",
	"If the lore or criteria mention living people then ensure you talk more about people and what they are doing than the natural events.",
	"Write subtle Tolkien-like prose mixed with world simulation.",
    "Never use second-person language. Never say 'you'.",
    "Write in the present tense.",
    "No modern references. No emojis. No hashtags. No quotes.",
    "Avoid named canon characters.",
    "Length: 1–2 sentences, ideally under 150 characters, never exceed 200 characters.",
    "Return ONLY the message text.",
  ].join(" ");

  const user = [
    `Channel: #${channelName || "unknown"}`,
    `Location: ${locationName || "Unknown"}`,
    `Lore: ${lore || ""}`,
    `Criteria: ${criteria || ""}`,
    `Danger level: ${dangerLevel || "low"}`,
    `Tone: ${tone}`,
    `Time of day: ${timeOfDay}`,
    "",
    "Describe a small ambient event happening now in this place.",
    "Include at least two of: time-of-day, weather, sounds, small wildlife, subtle supernatural hint (rare).",
    "No dialogue. No direct instructions.",
  ].join("\n");

  console.log("[OpenAI] Generating:", locationName, "| tone:", tone);

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 1.0,
      max_output_tokens: 70,
    }),
  });

if (!res.ok) {
  const errText = await res.text();
  console.error("[OpenAI] Error:", res.status, errText);

  // Surface the useful bit in Discord (without dumping secrets)
  let short = errText;
  if (short.length > 300) short = short.slice(0, 300) + "...";

  throw new Error(`OpenAI ${res.status}: ${short}`);
}


  const data = await res.json();

  const text = (data.output || [])
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("")
    .trim();

  if (!text) {
    console.error("[OpenAI] Empty response:", JSON.stringify(data).slice(0, 800));
    throw new Error("OpenAI returned no text.");
  }

  return trimNicely(text, 220);
}

// ---------- Discord ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
  .setName("ambient_export")
  .setDescription("Export all ambient channel configs as a JSON file.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON(),

new SlashCommandBuilder()
  .setName("ambient_import")
  .setDescription("Import ambient configs from a JSON file (replaces current configs).")
  .addAttachmentOption(opt =>
    opt.setName("file").setDescription("Upload channel-config.json").setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .toJSON(),
new SlashCommandBuilder()
    .setName("ambient_set")
    .setDescription("Configure ambient LOTR events for this channel.")
    .addStringOption((opt) =>
      opt.setName("location").setDescription("Location name").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("danger")
        .setDescription("How ominous this place gets overall")
        .setRequired(true)
        .addChoices(
          { name: "low", value: "low" },
          { name: "medium", value: "medium" },
          { name: "high", value: "high" }
        )
    )
    .addStringOption((opt) =>
      opt.setName("lore").setDescription("Location lore").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("criteria").setDescription("Extra rules").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("ambient_enable")
    .setDescription("Enable scheduled ambient posts in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("ambient_disable")
    .setDescription("Disable scheduled ambient posts in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("ambient_show")
    .setDescription("Show the current ambient configuration for this channel.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("ambient_post_now")
    .setDescription("Generate and post an ambient message immediately (test).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log("Slash commands registered.");
}

async function postToChannel(channelId, cfg) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const c = cfg.channels[channelId];
  if (!c?.enabled) return;

  const msg = await generateAmbientMessage({
    locationName: c.location,
    lore: c.lore,
    criteria: c.criteria,
    channelName: channel.name || "unknown",
    dangerLevel: c.danger || "low",
  });

  await channel.send(msg);
  c.lastPostedAt = new Date().toISOString();
}

async function runScheduledPosts() {
  const cfg = await loadConfig();
  for (const channelId of Object.keys(cfg.channels || {})) {
    try {
      await postToChannel(channelId, cfg);
    } catch (e) {
      console.error("Scheduled post failed for channel", channelId, e);
    }
  }
  await saveConfig(cfg);
}

function startSchedule() {
  // First run shortly after startup, then every 10 hours
  setTimeout(() => runScheduledPosts().catch(console.error), 29_000);
  setInterval(() => runScheduledPosts().catch(console.error), POST_EVERY_MS);
  console.log("Rolling schedule started: every 10 hours from startup.");
}

client.once("ready", async () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  await registerCommands();
  startSchedule();
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.commandName === "ambient_export") {
  const cfg = await loadConfig();
  const json = JSON.stringify(cfg, null, 2);
  const attachment = new AttachmentBuilder(Buffer.from(json, "utf8"), {
    name: "channel-config.json",
  });

  await interaction.reply({
    content: "Here’s the current ambient config file:",
    files: [attachment],
    ephemeral: true,
  });
  return;
}
if (interaction.commandName === "ambient_import") {
  const file = interaction.options.getAttachment("file", true);

  // Basic safety: only accept JSON-ish files
  if (!file.name.toLowerCase().endsWith(".json")) {
    await interaction.reply({ content: "❌ Please upload a .json file.", ephemeral: true });
    return;
  }

  await interaction.reply({ content: "Importing…", ephemeral: true });

  // Download the uploaded file
  const res = await fetch(file.url);
  if (!res.ok) {
    await interaction.followUp({ content: "❌ Could not download the uploaded file.", ephemeral: true });
    return;
  }

  const text = await res.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    await interaction.followUp({ content: "❌ That file is not valid JSON.", ephemeral: true });
    return;
  }

  // Validate shape
  if (!parsed || typeof parsed !== "object" || typeof parsed.channels !== "object") {
    await interaction.followUp({
      content: "❌ JSON must contain a top-level object with a 'channels' object.",
      ephemeral: true,
    });
    return;
  }

  // Save
  await saveConfig(parsed);
  await interaction.followUp({ content: "✅ Imported successfully. (This replaces existing configs.)", ephemeral: true });
  return;
}
if (!interaction.isChatInputCommand()) return;

  const cfg = await loadConfig();
  const channelId = interaction.channelId;
  cfg.channels ||= {};

  try {
    if (interaction.commandName === "ambient_set") {
      const location = interaction.options.getString("location", true);
      const danger = interaction.options.getString("danger", true);
      const lore = interaction.options.getString("lore", true);
      const criteria = interaction.options.getString("criteria", true);

      cfg.channels[channelId] = {
        ...(cfg.channels[channelId] || {}),
        location,
        danger,
        lore,
        criteria,
        enabled: cfg.channels[channelId]?.enabled ?? true,
        updatedAt: new Date().toISOString(),
      };

      await saveConfig(cfg);
      await interaction.reply({ content: "✅ Location configured.", ephemeral: true });
      return;
    }

    if (interaction.commandName === "ambient_enable") {
      cfg.channels[channelId] ||= { location: "Unknown", danger: "low", lore: "", criteria: "" };
      cfg.channels[channelId].enabled = true;
      await saveConfig(cfg);
      await interaction.reply({ content: "✅ Enabled for this channel.", ephemeral: true });
      return;
    }

    if (interaction.commandName === "ambient_disable") {
      cfg.channels[channelId] ||= { location: "Unknown", danger: "low", lore: "", criteria: "" };
      cfg.channels[channelId].enabled = false;
      await saveConfig(cfg);
      await interaction.reply({ content: "🛑 Disabled for this channel.", ephemeral: true });
      return;
    }

    if (interaction.commandName === "ambient_show") {
      const c = cfg.channels[channelId];
      if (!c) {
        await interaction.reply({ content: "No config set yet. Use /ambient_set.", ephemeral: true });
        return;
      }
      await interaction.reply({
        content:
          `Location: ${c.location}\n` +
          `Danger: ${c.danger}\n` +
          `Enabled: ${c.enabled ? "Yes" : "No"}\n` +
          `Lore: ${c.lore}\n` +
          `Criteria: ${c.criteria}\n` +
          `Last posted: ${c.lastPostedAt || "(never)"}`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "ambient_post_now") {
      await interaction.reply({ content: "Generating…", ephemeral: true });
      try {
        await postToChannel(channelId, cfg);
        await saveConfig(cfg);
        await interaction.followUp({ content: "✅ Posted.", ephemeral: true });
      } catch (e) {
        console.error("[ambient_post_now] Failed:", e);
        await interaction.followUp({
          content: `❌ Failed: ${e?.message || "Check bot logs."}`,
          ephemeral: true,
        });
      }
      return;
    }
  } catch (e) {
    console.error(e);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "❌ Something went wrong. Check logs.", ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: "❌ Something went wrong. Check logs.", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);
