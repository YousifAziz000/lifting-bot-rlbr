import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const APP_URL = process.env.APP_URL;       // Google Apps Script Web App URL
const APP_SECRET = process.env.APP_SECRET; // the SECRET you set in Apps Script
const GUILD_ID = process.env.GUILD_ID || ''; // optional: your server ID for instant commands

async function appPost(fn, body){
  const url = `${APP_URL}?fn=${encodeURIComponent(fn)}&secret=${encodeURIComponent(APP_SECRET)}`;
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  return await res.json();
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let EXERCISE_CACHE = { names: [], fetchedAt: 0 };
async function getExercises(){
  const now = Date.now();
  if (EXERCISE_CACHE.names.length && (now - EXERCISE_CACHE.fetchedAt) < 5*60*1000) { // 5 min cache
    return EXERCISE_CACHE.names;
  }
  const out = await appPost('list_exercises', {});
  const list = (out.ok ? out.exercises : []) || [];
  EXERCISE_CACHE = { names: list, fetchedAt: now };
  return list;
}

const commands = [
  new SlashCommandBuilder()
    .setName('session_start')
    .setDescription('Start a session (optional: paste GPT BOT_MESSAGE)')
    .addStringOption(o=>o.setName('plan').setDescription('Paste BOT_MESSAGE block').setRequired(false)),
  
new SlashCommandBuilder()
  .setName('log')
  .setDescription('Log a set')
  .addStringOption(o =>
    o.setName('exercise')
     .setDescription('Exercise')
     .setRequired(true)
     .setAutocomplete(true)   // ← add this
  )
  .addNumberOption(/* weight ... */)
  .addIntegerOption(/* reps ... */)
  .addStringOption(/* notes ... */)

  new SlashCommandBuilder()
    .setName('session_end')
    .setDescription('End session and get a SESSION_SUMMARY block')
].map(c=>c.toJSON());

client.once('ready', async () => {
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

const sessionKey = id => `sid:${id}`;

client.on('interactionCreate', async (i) => {
  try{
    if (!i.isChatInputCommand()) return;

  // --- Autocomplete for /log exercise ---
    if (i.isAutocomplete()) {
      const cmd = i.commandName;
      if (cmd === 'log') {
        const focused = i.options.getFocused(true); // { name, value }
        if (focused.name === 'exercise') {
          const q = (focused.value || '').toLowerCase();
          const all = await getExercises();
          // rank by startsWith first, then includes; keep max 25 as Discord requires
          const starts = all.filter(n => n.toLowerCase().startsWith(q));
          const contains = all.filter(n => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
          const picks = [...starts, ...contains].slice(0, 25);
          return i.respond(picks.map(name => ({ name, value: name })));
        }
      }
      return; // don’t fall through
    }

    // ... your existing handlers for /session_start, /log, /session_end ...

  } catch (err) {
    console.error(err);
    if (i.isAutocomplete()) return; // autocomplete must not attempt editReply
    if (i.deferred) return i.editReply(`❌ Error: ${String(err)}`);
    i.reply({ content:`❌ Error: ${String(err)}`, ephemeral:true });
  }
    
    if (i.commandName === 'session_start'){
      await i.deferReply({ ephemeral: false });
      const plan = i.options.getString('plan') || '';
      const out = await appPost('session_start', { maybe_plan_text: plan });
      if (!out.ok) return i.editReply(`❌ session_start error: ${out.error}`);
      client[sessionKey(i.channelId)] = out.session_id;

      const lines = (out.checklist||[]).map((c,idx)=>{
        const tw = c.target_weight!=null? c.target_weight : '?';
        const tr = c.target_reps!=null? c.target_reps : '?';
        return `${idx+1}) ${c.exercise} — Target: ${tw}×${tr}`;
      });
      const msg = lines.length ? lines.join('\n') : 'No targets yet. Log freely.';
      return i.editReply(`🟢 Session started: \`${client[sessionKey(i.channelId)]}\`\n🔥 SESSION CHECKLIST\n${msg}`);
    }

    if (i.commandName === 'log'){
      await i.deferReply({ ephemeral: false });
      const sid = client[sessionKey(i.channelId)];
      if (!sid) return i.editReply('⚠️ No active session. Use /session_start first.');
      const exercise = i.options.getString('exercise');
      const weight = i.options.getNumber('weight');
      const reps = i.options.getInteger('reps');
      const notes = i.options.getString('notes') || '';
      const out = await appPost('log_set', { session_id: sid, exercise, weight, reps, notes });
      if (!out.ok) return i.editReply(`❌ log error: ${out.error}`);
      const nt = out.nextTarget || {};
      const tail = (nt.target_weight && nt.target_reps) ? ` • Next target: ${nt.target_weight}×${nt.target_reps}` : '';
      return i.editReply(`✅ Logged: ${exercise} — ${weight}×${reps}${notes?` (${notes})`:''}${tail}`);
    }

    if (i.commandName === 'session_end'){
      await i.deferReply({ ephemeral: false });
      const sid = client[sessionKey(i.channelId)];
      if (!sid) return i.editReply('⚠️ No active session. Use /session_start first.');
      const out = await appPost('session_end', { session_id: sid });
      if (!out.ok) return i.editReply(`❌ session_end error: ${out.error}`);
      client[sessionKey(i.channelId)] = null;
      return i.editReply("```text\n" + out.summary_text + "\n```");
    }

  } catch(err){
    console.error(err);
    if (i.deferred) return i.editReply(`❌ Error: ${String(err)}`);
    i.reply({ content:`❌ Error: ${String(err)}`, ephemeral:true });
  }
});

client.login(TOKEN);
