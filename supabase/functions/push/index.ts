// Этап 6 ТЗ «Зал»: пуши. Вызывается двумя способами:
// 1) расписанием pg_cron раз в 15 минут (заголовок x-cron-secret) — проверяет всех и шлёт, что положено;
// 2) из приложения с входом пользователя {test:true} — пробный пуш себе.
// Ключи VAPID и секрет расписания лежат в Vault, читаются функцией push_config() только сервисным ключом.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import webpush from "npm:web-push@3.6.7";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const LIMIT_PER_DAY = 2;
const REST_AFTER_MIN = 210;   // «отдыхай» через 3,5 часа
const CATCHUP_MIN = 60;       // если расписание пропустило запуск, догоняем в течение часа
const IDLE_DAYS = 7, IDLE_REPEAT_DAYS = 3;

let cfg: { pub: string; priv: string; cron: string } | null = null;
async function config() {
  if (cfg) return cfg;
  const { data, error } = await db.rpc("push_config");
  if (error || !data) throw new Error("push_config: " + (error?.message || "пусто"));
  cfg = data as typeof cfg;
  webpush.setVapidDetails("mailto:zal-app@users.noreply.github.com", cfg!.pub, cfg!.priv);
  return cfg!;
}

// Местные дата, время и день недели в часовом поясе человека
function local(tz: string, at = new Date()) {
  let p: Record<string, string>;
  try { p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(at).map(x => [x.type, x.value])); }
  catch { return local("Asia/Almaty", at); }
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { day: `${p.year}-${p.month}-${p.day}`, min: (+p.hour) * 60 + (+p.minute), dow, dom: +p.day };
}
const hm = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ""); return m ? (+m[1]) * 60 + (+m[2]) : 19 * 60; };
const inWindow = (nowMin: number, at: number) => nowMin >= at && nowMin < at + CATCHUP_MIN;

type Sub = { endpoint: string; p256dh: string; auth: string };
async function sendTo(uid: string, subs: Sub[], msg: { title: string; body: string; tag: string }) {
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ ...msg, url: "./" }), { TTL: 3 * 3600, urgency: "normal" });
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
      console.log("push fail", uid.slice(0, 8), code, String((e as Error).message || e).slice(0, 200));
    }
  }
  return ok;
}

async function runSchedule() {
  await config();
  const now = new Date();
  const { data: subs } = await db.from("push_subs").select("user_id,endpoint,p256dh,auth");
  if (!subs?.length) return { users: 0, sent: 0 };
  const byUser = new Map<string, Sub[]>();
  for (const s of subs) { if (!byUser.has(s.user_id)) byUser.set(s.user_id, []); byUser.get(s.user_id)!.push(s); }
  const ids = [...byUser.keys()];
  const [{ data: profs }, { data: logs }, { data: admins }] = await Promise.all([
    db.from("profiles").select("user_id,email,name,data").in("user_id", ids),
    db.from("push_log").select("user_id,kind,ref,local_day,sent_at").in("user_id", ids).gte("sent_at", new Date(now.getTime() - 35 * 864e5).toISOString()),
    db.from("allowed_emails").select("email").eq("is_admin", true),
  ]);
  const adminSet = new Set((admins || []).map(a => a.email));
  let sent = 0;
  for (const uid of ids) {
    const p = (profs || []).find(x => x.user_id === uid); if (!p) continue;
    const d = (p.data || {}) as Record<string, any>;
    if (d.push === false) continue;                       // выключатель в профиле
    const tz = d.tz || "Asia/Almaty", L = local(tz, now);
    const my = (logs || []).filter(l => l.user_id === uid);
    if (my.filter(l => l.local_day === L.day).length >= LIMIT_PER_DAY) continue;   // не больше 2 в день
    const nick = String(d.nick || d.name || p.name || "").trim();
    const say = (t: string) => nick ? `${nick}, ${t}` : t[0].toUpperCase() + t.slice(1);
    const { data: ws } = await db.from("workouts").select("id,data").eq("user_id", uid).eq("deleted", false).order("started_at", { ascending: false }).limit(10);
    const fin = (ws || []).map(w => ({ id: w.id, t: Date.parse(w.data?.finishedAt || w.data?.startedAt || "") })).filter(w => !isNaN(w.t));
    const lastT = fin.length ? Math.max(...fin.map(w => w.t)) : (d.onboarded ? Date.parse(d.onboarded) : NaN);
    const trainedToday = fin.some(w => local(tz, new Date(w.t)).day === L.day);
    const rm = d.remind || {}, rmAt = hm(rm.time), rmDay = Array.isArray(rm.days) && rm.days.includes(L.dow);
    let msg: { kind: string; ref: string; title: string; body: string } | null = null;

    // 1) «отдыхай» через 3,5 часа после тренировки (не ночью: с 8:00 до 22:30)
    for (const w of fin) {
      const due = w.t + REST_AFTER_MIN * 60000;
      if (L.min >= 8 * 60 && L.min < 22 * 60 + 30 && now.getTime() >= due && now.getTime() < due + CATCHUP_MIN * 60000 && !my.some(l => l.kind === "rest" && l.ref === w.id)) {
        msg = { kind: "rest", ref: w.id, title: "Зал", body: say("шикарная тренировка. Теперь еда и отдых") }; break;
      }
    }
    // 2) напоминание в день тренировки, если сегодня ещё не тренировался
    if (!msg && rmDay && !trainedToday && inWindow(L.min, rmAt) && !my.some(l => l.kind === "remind" && l.local_day === L.day))
      msg = { kind: "remind", ref: L.day, title: "Зал", body: say("сегодня день тренировки. Погнали 💪") };
    // 3) «давно не были» после 7 дней без тренировок, не чаще раза в 3 дня, в обычное время напоминания
    if (!msg && !isNaN(lastT) && now.getTime() - lastT >= IDLE_DAYS * 864e5 && inWindow(L.min, rmAt)
      && !my.some(l => (l.kind === "idle" && now.getTime() - Date.parse(l.sent_at) < IDLE_REPEAT_DAYS * 864e5) || (l.kind === "remind" && l.local_day === L.day))) {
      const days = Math.floor((now.getTime() - lastT) / 864e5);
      msg = { kind: "idle", ref: L.day, title: "Зал", body: say(`давно не были в зале: ${days} дн. без тренировки. Вернёмся?`) };
    }
    // 4) администратору 1-го числа: сохранить копию семьи
    if (!msg && adminSet.has(p.email) && L.dom === 1 && inWindow(L.min, 12 * 60) && !my.some(l => l.kind === "backup" && l.local_day === L.day))
      msg = { kind: "backup", ref: L.day, title: "Зал", body: "Начало месяца: сохрани копию семьи (История → Сохранить копию)" };

    if (!msg) continue;
    const ok = await sendTo(uid, byUser.get(uid)!, { title: msg.title, body: msg.body, tag: msg.kind });
    if (ok) { await db.from("push_log").insert({ user_id: uid, kind: msg.kind, ref: msg.ref, local_day: L.day }); sent++; }
  }
  return { users: ids.length, sent };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const c = await config();
    if (req.headers.get("x-cron-secret")) {
      if (req.headers.get("x-cron-secret") !== c.cron) return json({ error: "forbidden" }, 403);
      return json(await runSchedule());
    }
    // пробный пуш от вошедшего пользователя
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(token);
    if (!u?.user) return json({ error: "auth" }, 401);
    const { data: subs } = await db.from("push_subs").select("endpoint,p256dh,auth").eq("user_id", u.user.id);
    if (!subs?.length) return json({ sent: 0, error: "nosub" });
    const ok = await sendTo(u.user.id, subs, { title: "Зал", body: "Пробный пуш: уведомления работают 👍", tag: "test" });
    return json({ sent: ok });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
