// RLBR Lift Logger — clean checklist, modal plan paste, fast autocomplete

import 'dotenv/config';
import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder
} from 'discord.js';

const TOKEN      = process.env.DISCORD_TOKEN;
const APP_URL    = process.env.APP_URL;        // Apps Script Web App /exec
const APP_SECRET = process.env.APP_SECRET;     // same SECRET as in Apps Script
const GUILD_ID   = process.env.GUILD_ID || ''; // optional: server ID for instant commands

/* -------------------- HTTP helper -------------------- */
async function appPost(fn, body) {
  const url = `${APP_URL}?fn=${encodeURIComponent(fn)}&secret=${encodeURIComponent(APP_SECRET)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body || {})
  });
  return await res.json();
}

/* -------- fallback exercise list (for safety) -------- */
const FALLBACK_EXERCISES = [
  'Barbell Bench Press','Barbell Incline Bench Press','Dumbbell Bench Press','Dumbbell Incline Bench Press',
  'Machine Chest Press','Smith Machine Bench Press','Barbell Overhead Press','Seated Dumbbell Overhead Press',
  'Cable Chest Fly','Pec Deck Fly','Triceps Rope Pushdown','Triceps Single-Arm Cable Overhead Extension',
  'Triceps Single-Arm Rope Pushdown','Chest-Supported Row','Close-Grip Seated Cable Row',
  'Wide-Grip Seated Cable Row','Lat Pulldown','Dumbbell Hammer Curl','Cable Hammer Curl','Reverse Curls',
  'Behind-the-Back Barbell Wrist Curls','Barbell Curl','Bayesian Cable Curl','EZ Bar Curl','Single-Arm Preacher Curl',
  'Seated Dumbbell Curl','Back Squat','Smith Machine Squat','Hack Squat','Leg Press','Barbell Romanian Deadlifts',
  'Seated Leg Curl','Leg Extension','Hip Abduction','Hip Adduction','Standing Calf Raise',
  'Cable Lateral Raises','Cable Rear Delt Fly','Low Row Machine','Shrugs','Ab Crunch Machine',
  'Weighted Back Extensions','Forward Neck Crunch','Neck Extension','Lateral Neck Crunch'
];

/* ---------- exercise cache + canonical set ---------- */
let EXERCISE_CACHE = { names: [], fetchedAt: 0 };

function getCachedExercises() {
  return (EXERCISE_CACHE.names && EXERCISE_CACHE.names.length)
    ? EXERCISE_CACHE.names
    : FALLBACK_EXERCISES;
}
function getCanonicalSet() {
  return new Set(getCachedExercises().map(n => String(n).trim()));
}

async function fetchWithTimeout(promise, ms = 2000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}
async function refreshExercises() {
  try {
    const out = await fetchWithTimeout(appPost('list_exercises', {}), 2000);
    const list = (out && out.ok && Array.isArray(out.exercises)) ? out.exercises : [];
    if (list.length) {
      EXERCISE_CACHE = { names: list, fetchedAt: Date.now() };
      console.log(`[cache] loaded ${list.length} exercises from Sheets`);
    } else {
      console.log('[cache] empty/unchanged — using current cache');
    }
  } catch {
    console.log('[cache] refresh failed/timeout — using fallback/current cache');
  }
}

/* -------------------- Slash commands -------------------- */
const commands = [
  new SlashCommandBuilder()
    .setName('session_start')
    .setDescription('Start a session (leave plan empty to paste via modal)')
    .addStringOption(o =>
      o.setName('plan')
       .setDescription('Optional: paste BOT_MESSAGE here if short; otherwise leave empty to open a modal')
       .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('log')
    .setDescription('Log a set')
    .addStringOption(o =>
      o.setName('exercise').setDescription('Exercise').setRequired(true).setAutocomplete(true)
    )
    .addNumberOption(o => o.setName('weight').setDescription('Weight').setRequired(true))
    .addIntegerOption(o => o.setName('reps').setDescription('Reps').setRequired(true))
    .addStringOption(o => o.setName('notes').setDescription('Notes').setRequired(false)),

  new SlashCommandBuilder()
    .setName('session_end')
    .setDescription('End session and get a SESSION_SUMMARY block')
].map(c => c.toJSON());

/* ---------------- Discord client setup ------------------ */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const sessionKey = id => `sid:${id}`;
const MODAL_ID   = 'rlbr-plan-modal';
const MODAL_FIELD_ID = 'rlbr-plan-text';

client.once('ready', async () => {
  await refreshExercises();
  setInterval(refreshExercises, 5 * 60 * 1000);

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
        const focused = i.options.getFocused(true);
        if (focused.name === 'exercise') {
          const q = (focused.value || '').toLowerCase();
          const all = getCachedExercises();
          const starts   = all.filter(n => n.toLowerCase().startsWith(q));
          const contains = all.filter(n => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
          const picks    = (q ? [...starts, ...contains] : all).slice(0, 25);
          return i.respond(picks.map(name => ({ name, value: name })));
        }
      }
      return;
    }

    /* ---------- Modal submission (multi-line plan) ---------- */
    if (i.isModalSubmit && i.isModalSubmit()) {
      if (i.customId === MODAL_ID) {
        await i.deferReply({ ephemeral: false });
        const planText = i.fields.getTextInputValue(MODAL_FIELD_ID) || '';
        const out = await appPost('session_start', { maybe_plan_text: planText });
        if (!out.ok) return i.editReply(`❌ session_start error: ${out.error}`);
        const sid = out.session_id;
        client[sessionKey(i.channelId)] = sid;

        // SHOW ONLY CANONICAL EXERCISES
        const canon = getCanonicalSet();
        const clean = (out.checklist || [])
          .filter(c => c && c.exercise && canon.has(String(c.exercise).trim()));

        const lines = clean.map((c, idx) => {
          const tw = c.target_weight != null ? c.target_weight : '?';
          const tr = c.target_reps   != null ? c.target_reps   : '?';
          return `${idx + 1}) ${String(c.exercise).trim()} — Target: ${tw}×${tr}`;
        });
        const msg = lines.length ? lines.join('\n') : 'No targets yet. Log freely.';
        return i.editReply(`🟢 Session started: \`${sid}\`\n🔥 SESSION CHECKLIST\n${msg}`);
      }
      return;
    }

    if (!i.isChatInputCommand()) return;

    /* -------------------- /session_start -------------------- */
    if (i.commandName === 'session_start') {
      const plan = i.options.getString('plan') || '';

      if (!plan.trim()) {
        // open modal for long/multiline plan paste
        const modal = new ModalBuilder()
          .setCustomId(MODAL_ID)
          .setTitle('Paste your BOT_MESSAGE plan');

        const text = new TextInputBuilder()
          .setCustomId(MODAL_FIELD_ID)
          .setLabel('BOT_MESSAGE (include DATE, SETS, META)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('=== BOT_MESSAGE_START ===\nDATE: 2025-11-01\nSETS:\n1) Barbell Bench Press | 165 | 5 |\nMETA:\nSUGGEST_DELOAD: no\nCARDIO_MINUTES: 0\n=== BOT_MESSAGE_END ===');

        modal.addComponents(new ActionRowBuilder().addComponents(text));
        return i.showModal(modal);
      }

      await i.deferReply({ ephemeral: false });
      const out = await appPost('session_start', { maybe_plan_text: plan });
      if (!out.ok) return i.editReply(`❌ session_start error: ${out.error}`);
      const sid = out.session_id;
      client[sessionKey(i.channelId)] = sid;

      // SHOW ONLY CANONICAL EXERCISES
      const canon = getCanonicalSet();
      const clean = (out.checklist || [])
        .filter(c => c && c.exercise && canon.has(String(c.exercise).trim()));

      const lines = clean.map((c, idx) => {
        const tw = c.target_weight != null ? c.target_weight : '?';
        const tr = c.target_reps   != null ? c.target_reps   : '?';
        return `${idx + 1}) ${String(c.exercise).trim()} — Target: ${tw}×${tr}`;
      });
      const msg = lines.length ? lines.join('\n') : 'No targets yet. Log freely.';
      return i.editReply(`🟢 Session started: \`${sid}\`\n🔥 SESSION CHECKLIST\n${msg}`);
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
    if (i.isAutocomplete && i.isAutocomplete()) return; // autocomplete replies can't be edited
    if (i.deferred) return i.editReply(`❌ Error: ${String(err)}`);
    return i.reply({ content: `❌ Error: ${String(err)}`, ephemeral: true });
  }
});

client.login(TOKEN);
