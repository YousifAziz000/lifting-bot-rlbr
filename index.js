// index.js — Discord bot for RLBR Lift Logger (with fast autocomplete)

import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';

const TOKEN      = process.env.DISCORD_TOKEN;
const APP_URL    = process.env.APP_URL;        // Apps Script Web App /exec
const APP_SECRET = process.env.APP_SECRET;     // same SECRET as in Apps Script
const GUILD_ID   = process.env.GUILD_ID || ''; // optional: server ID for instant command registration

/* ---------------------- HTTP helper ---------------------- */
async function appPost(fn, body) {
  const url = `${APP_URL}?fn=${encodeURIComponent(fn)}&secret=${encodeURIComponent(APP_SECRET)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body || {})
  });
  return await res.json();
}

/* -------------- exercise cache for autocomplete ---------- */
let EXERCISE_CACHE = { names: [], fetchedAt: 0 };

function getCachedExercises() {
  return EXERCISE_CACHE.names || [];
}

// fetch with hard timeout so autocomplete never hangs
async function fetchWithTimeout(promise, ms = 1500) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function refreshExercises() {
  try {
    const out = await fetchWithTimeout(appPost('list_exercises', {}), 1500);
    const list = (out && out.ok && Array.isArray(out.exercises)) ? out.exercises : [];
    if (list.length) EXERCISE_CACHE = { names: list, fetchedAt: Date.now() };
  } catch {
    // keep old cache on timeout/network hiccup
  }
}

/* -------------------- Slash commands -------------------- */
const commands = [
  new SlashCommandBuilder()
    .setName('session_start')
    .setDescription('Start a session (optional: paste GPT BOT_MESSAGE)')
    .addStringOption(o =>
      o.setName('plan')
       .setDescription('Paste BOT_MESSAGE block')
       .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('log')
    .setDescription('Log a set')
    .addStringOption(o =>
      o.setName('exercise')
       .setDescription('Exercise')
       .setRequired(true)
       .setAutocomplete(true)
    )
    .addNumberOption(o =>
      o.setName('weight')
       .setDescription('Weight')
       .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('reps')
       .setDescription('Reps')
       .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('notes')
       .setDescription('Notes')
       .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('session_end')
    .setDescription('End session and get a SESSION_SUMMARY block')
].map(c => c.toJSON());

/* ---------------- Discord client setup ------------------ */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const sessionKey = id => `sid:${id}`;

client.once('ready', async () => {
  // Pre-warm the exercise cache and refresh every 5 min (non-blocking)
  await refreshExercises();
  setInterval(refreshExercises, 5 * 60 * 1000);

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const appId = client.user.id;
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: commands });
    console.log('Commands registered (guild).');
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('Commands registered (global).');
  }
  console.log(`Logged in as ${client.user.tag}`);
});

/* --------------- Interaction handling ------------------- */
client.on('interactionCreate', async (i) => {
  try {
    /* ---------- Autocomplete for /log exercise ---------- */
    if (i.isAutocomplete()) {
      if (i.commandName === 'log') {
        const focused = i.options.getFocused(true); // { name, value }
        if (focused.name === 'exercise') {
          const q = (focused.value || '').toLowerCase();
          const all = getCachedExercises();

          // If cache is empty, kick off a refresh in the background
          if (!all.length) refreshExercises();

          // rank suggestions: startsWith first, then contains
          const starts   = all.filter(n => n.toLowerCase().startsWith(q));
          const contains = all.filter(n => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
          const picks    = [...starts, ...contains].slice(0, 25);

          // Always respond within ~3s even if empty (Discord requirement)
          return i.respond(picks.map(name => ({ name, value: name })));
        }
      }
      return;
    }

    if (!i.isChatInputCommand()) return;

    /* -------------------- /session_start -------------------- */
    if (i.commandName === 'session_start') {
      await i.deferReply({ ephemeral: false });
      const plan = i.options.getString('plan') || '';
      const out  = await appPost('session_start', { maybe_plan_text: plan });
      if (!out.ok) return i.editReply(`❌ session_start error: ${out.error}`);
      client[sessionKey(i.channelId)] = out.session_id;

      const lines = (out.checklist || []).map((c, idx) => {
        const tw = c.target_weight != null ? c.target_weight : '?';
        const tr = c.target_reps   != null ? c.target_reps   : '?';
        return `${idx + 1}) ${c.exercise} — Target: ${tw}×${tr}`;
      });
      const msg = lines.length ? lines.join('\n') : 'No targets yet. Log freely.';
      return i.editReply(`🟢 Session started: \`${client[sessionKey(i.channelId)]}\`\n🔥 SESSION CHECKLIST\n${msg}`);
    }

    /* ------------------------ /log ------------------------- */
    if (i.commandName === 'log') {
      await i.deferReply({ ephemeral: false });
      const sid = client[sessionKey(i.channelId)];
      if (!sid) return i.editReply('⚠️ No active session. Use /session_start first.');

      const exercise = i.options.getString('exercise');
      const weight   = i.options.getNumber('weight');
      const reps     = i.options.getInteger('reps');
      const notes    = i.options.getString('notes') || '';

      const out = await appPost('log_set', { session_id: sid, exercise, weight, reps, notes });
      if (!out.ok) return i.editReply(`❌ log error: ${out.error}`);

      const nt   = out.nextTarget || {};
      const tail = (nt.target_weight && nt.target_reps) ? ` • Next target: ${nt.target_weight}×${nt.target_reps}` : '';
      return i.editReply(`✅ Logged: ${exercise} — ${weight}×${reps}${notes ? ` (${notes})` : ''}${tail}`);
    }

    /* -------------------- /session_end -------------------- */
    if (i.commandName === 'session_end') {
      await i.deferReply({ ephemeral: false });
      const sid = client[sessionKey(i.channelId)];
      if (!sid) return i.editReply('⚠️ No active session. Use /session_start first.');

      const out = await appPost('session_end', { session_id: sid });
      if (!out.ok) return i.editReply(`❌ session_end error: ${out.error}`);

      client[sessionKey(i.channelId)] = null;
      return i.editReply("```text\n" + out.summary_text + "\n```");
    }

  } catch (err) {
    console.error(err);
    // Don’t try to editReply for autocomplete
    if (i.isAutocomplete && i.isAutocomplete()) return;
    if (i.deferred) return i.editReply(`❌ Error: ${String(err)}`);
    return i.reply({ content: `❌ Error: ${String(err)}`, ephemeral: true });
  }
});

client.login(TOKEN);
