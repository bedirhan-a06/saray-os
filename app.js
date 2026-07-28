/* ================= Saray OS – App-Logik ================= */
"use strict";

/* ---- Supabase (eigenes Projekt von Bedirhan) ---- */
const SUPABASE_URL = "https://whooaauysrlxkmhalqfm.supabase.co";
const SUPABASE_KEY = "sb_publishable_yg_gPdvQYAxR8qEv0alR8Q_j0x0rfxI";
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---- Konstanten ---- */
const CATEGORIES = {
  Streaming: "#e879a0",
  Musik: "#7dd3a7",
  Software: "#7c9eff",
  Gaming: "#66b6f0",
  Cloud: "#b9a0f2",
  Sonstige: "#d4af37"
};
const CURRENCY_LOCALE = { EUR: "de-DE", USD: "en-US", CHF: "de-CH", TRY: "tr-TR" };

/* ---- State ---- */
let user = null;
let profile = null;
let subs = [];
let history = {};       // subscription_id -> [{old_price,new_price,changed_at}]
let editingId = null;
let todos = [];
let editingTodoId = null;
let notes = [];
let editingNoteId = null;
let activeNoteTag = "Alle";
let projects = [];
let editingProjectId = null;
let activeProjectKind = "Alle";
let authMode = "login"; // 'login' | 'register'
let activeCat = "Alle";
let activeTab = "home";
let dismissedSavings = false;
// Merkt sich das eine To-Do, das gerade angetippt wurde. renderAll() baut die
// Zeilen neu auf – ohne diese Markierung würde der Häkchen-Impuls bei jedem
// Neuzeichnen auf allen erledigten To-Dos gleichzeitig losgehen.
let ebenAbgehakt = null;
let abhakTimer = null;

/* ---- Helpers ---- */
const $ = (id) => document.getElementById(id);
function fmt(n) {
  const cur = profile?.currency || "EUR";
  // Postgres liefert numeric als String ("10.00") – ohne Number() ignoriert
  // toLocaleString die Optionen und der Betrag käme unformatiert durch.
  const v = Number(n);
  if (!isFinite(v)) return "–";
  return v.toLocaleString(CURRENCY_LOCALE[cur] || "de-DE", { style: "currency", currency: cur });
}
function fmtDate(d) {
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtDateTime(d) {
  return `${fmtDate(d)} · ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
}
// Ausgeschrieben für den Kopfbereich: „Montag, 27. Juli"
function fmtDatumLang(d) {
  return d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
}
function todayMidnight() { const t = new Date(); t.setHours(0, 0, 0, 0); return t; }
// Lokales Datum als YYYY-MM-DD. Nicht über toISOString – das rechnet in UTC um
// und macht aus lokaler Mitternacht den Vortag.
function toDateStr(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Monate addieren ohne Überlauf: der 31.01. + 1 Monat ergibt den 28./29.02., nicht den 02./03.03.
// anchorDay hält den ursprünglichen Stichtag fest, damit das Datum nicht Monat für Monat wandert.
function addMonths(date, months, anchorDay) {
  const y = date.getFullYear();
  const m = date.getMonth() + months;
  const day = anchorDay || date.getDate();
  const lastDayOfTarget = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, lastDayOfTarget));
}
// Eingetragen wird der Preis so, wie er auf der Rechnung steht. Ist ein
// MwSt-Satz gesetzt, gilt der Betrag als netto und der Satz kommt oben drauf.
// Alle Geldrechnungen laufen ueber diese Funktion, nicht ueber s.price.
function bruttoPreis(s) {
  return Number(s.price) * (1 + (Number(s.vat_percent) || 0) / 100);
}
function ownShareMonthly(s) { return bruttoPreis(s) / s.cycle_months / (s.shared_with_count || 1); }
// Gemeinsame Ampel für alles mit Fälligkeitsdatum (Abo-Karten und To-Dos):
// rot/nah, gelb/mittel, grün/fern. dateStr im Format "YYYY-MM-DD".
function dateBadge(dateStr) {
  if (!dateStr) return ["far", "ohne Termin"];
  const today = todayMidnight();
  const d = new Date(dateStr + "T00:00:00");
  const diff = Math.round((d - today) / 864e5);
  return diff < 0 ? ["soon", "überfällig"]
    : diff === 0 ? ["soon", "heute"]
    : diff === 1 ? ["soon", "morgen"]
    : diff <= 7 ? ["soon", `in ${diff} Tagen`]
    : diff <= 21 ? ["mid", `in ${diff} Tagen`]
    : ["far", `in ${diff} Tagen`];
}
function cycleText(m) { return m === 1 ? "/ Monat" : m === 12 ? "/ Jahr" : `/ ${m} Monate`; }
function esc(str) { const d = document.createElement("div"); d.textContent = str ?? ""; return d.innerHTML; }

// Icon aus dem Sprite in index.html; nimmt per currentColor die Umgebungsfarbe an
function svgIcon(name, cls) {
  return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/* ---- Tags: #wort in beliebigem Text wird zum app-weiten Querverweis ---- */
// Ein Mechanismus für alles: Notiz-Inhalt, To-Do-Titel, Abo- und Projekt-Notiz.
// Keine eigene Spalte – der Text selbst trägt die Verknüpfung.
function extractTags(content) {
  const matches = (content || "").match(/#([\p{L}\p{N}_]+)/gu) || [];
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
}
// Erst escapen, dann markieren – so bleibt eingebettetes HTML wirkungslos.
function tagTextHTML(text) {
  return esc(text).replace(/#([\p{L}\p{N}_]+)/gu,
    (m, wort) => `<span class="tag-inline" data-tag="${wort.toLowerCase()}">#${wort}</span>`);
}
function todoTags(t) { return extractTags(`${t.title} ${t.description || ""}`); }

/* ---- Marken-Erkennung (BRANDS kommt aus brands.js) ---- */
// Manche Marken sind fast schwarz (Steam #000, GitHub #181717) und würden auf dem
// dunklen Hintergrund verschwinden – solche Farben so weit aufhellen, bis sie tragen.
function readableTone(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  let r = parseInt(full.slice(0, 2), 16),
      g = parseInt(full.slice(2, 4), 16),
      b = parseInt(full.slice(4, 6), 16);
  const lum = () => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  for (let i = 0; i < 24 && lum() < 0.42; i++) {
    r = Math.round(r + (255 - r) * 0.12);
    g = Math.round(g + (255 - g) * 0.12);
    b = Math.round(b + (255 - b) * 0.12);
  }
  return `rgb(${r},${g},${b})`;
}
// Suchbegriffe einmalig zu Regex kompilieren, statt bei jedem Rendern neu zu bauen.
BRANDS.forEach((b) => {
  const safe = b.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  b.re = new RegExp(`(^|[^a-z0-9])${safe}([^a-z0-9]|$)`);
  b.tone = readableTone(b.color);
});
function brandFor(name) {
  const n = (name || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!n) return null;
  // BRANDS ist nach Länge sortiert – der erste Treffer ist der spezifischste
  return BRANDS.find((b) => b.re.test(n)) || null;
}
// Kürzel aus dem Namen, wenn weder Logo noch Emoji da ist: "Mein Fitness" -> "MF"
function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join("").toUpperCase();
  return ([...parts[0]][0] + [...parts[1]][0]).toUpperCase();
}
// "📦" war früher der Standardwert – zählt daher als "kein Icon gesetzt"
function customIcon(s) {
  const c = (s.icon || "").trim();
  return c && c !== "📦" ? c : null;
}
function iconHTML(s) {
  const custom = customIcon(s);
  if (custom) return `<div class="icon">${esc(custom)}</div>`;
  const b = brandFor(s.name);
  if (b && b.path) {
    // Die meisten Logos sind 24x24; Zeichen aus anderen Sammlungen bringen
    // ihre eigene Groesse mit und stehen dann in box.
    return `<div class="icon brand" style="--brand:${b.tone}">
      <svg viewBox="${b.box || "0 0 24 24"}" aria-hidden="true"><path d="${b.path}"/></svg></div>`;
  }
  const color = b ? b.tone : (CATEGORIES[s.category] || CATEGORIES.Sonstige);
  return `<div class="icon mark" style="--brand:${color}">${esc(b ? b.text : initials(s.name))}</div>`;
}
function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2300);
}

/* ================= AUTH ================= */
async function initAuth() {
  const { data: { session } } = await db.auth.getSession();
  if (session) { user = session.user; await enterApp(); }
  db.auth.onAuthStateChange(async (event, session2) => {
    if (event === "SIGNED_IN" && session2 && !user) {
      user = session2.user;
      await enterApp();
    }
    if (event === "SIGNED_OUT") {
      user = null; profile = null; subs = []; todos = []; notes = []; projects = [];
      $("app-view").classList.add("hidden");
      $("auth-view").classList.remove("hidden");
    }
  });
}

$("auth-toggle").addEventListener("click", () => {
  authMode = authMode === "login" ? "register" : "login";
  $("auth-submit").textContent = authMode === "login" ? "Anmelden" : "Konto erstellen";
  $("auth-switch").firstChild.textContent = authMode === "login" ? "Noch kein Konto? " : "Schon ein Konto? ";
  $("auth-toggle").textContent = authMode === "login" ? "Registrieren" : "Anmelden";
  $("auth-error").textContent = "";
});

$("auth-submit").addEventListener("click", doAuth);
$("auth-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doAuth(); });

async function doAuth() {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  $("auth-error").textContent = "";
  if (!email || !password) { $("auth-error").textContent = "Bitte E-Mail und Passwort eingeben."; return; }
  $("auth-submit").disabled = true;
  try {
    if (authMode === "register") {
      const { data, error } = await db.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (data.session) { user = data.user; await enterApp(); }
      // Bei bereits registrierter E-Mail meldet Supabase absichtlich Erfolg (Schutz vor
      // dem Abklappern fremder Adressen) und verschickt nichts – erkennbar an leerem identities.
      else if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        $("auth-error").textContent = "Diese E-Mail ist bereits registriert. Melde dich an oder setz dein Passwort zurück.";
      }
      else $("auth-error").textContent = "Konto angelegt. Bestätige die E-Mail über den Link in deinem Postfach und melde dich dann an.";
    } else {
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
      user = data.user;
      await enterApp();
    }
  } catch (err) {
    const msg = (err.message || "").includes("Invalid login")
      ? "E-Mail oder Passwort falsch."
      : (err.message || "").includes("already registered")
        ? "Diese E-Mail ist bereits registriert."
        : err.message || "Etwas ist schiefgelaufen.";
    $("auth-error").textContent = msg;
  } finally {
    $("auth-submit").disabled = false;
  }
}

$("logout-btn").addEventListener("click", async () => {
  // Erst abmelden vom Push, sonst bekaeme das Geraet weiter fremde Erinnerungen
  await unregisterPush();
  await db.auth.signOut();
});

/* ---- Passwort ändern ---- */
function openPwDialog() {
  $("pw-new").value = "";
  $("pw-again").value = "";
  $("pw-error").textContent = "";
  $("pw-overlay").classList.add("open");
  setTimeout(() => $("pw-new").focus(), 60);
}
function closePwDialog() { $("pw-overlay").classList.remove("open"); }

async function savePw() {
  const neu = $("pw-new").value;
  const nochmal = $("pw-again").value;
  const fehler = $("pw-error");
  // Vor dem Serveraufruf prüfen, damit der Fehler sofort am Feld steht
  if (neu.length < 6) { fehler.textContent = "Mindestens 6 Zeichen."; $("pw-new").focus(); return; }
  if (neu !== nochmal) { fehler.textContent = "Die beiden Eingaben stimmen nicht überein."; $("pw-again").focus(); return; }
  fehler.textContent = "";
  const btn = $("pw-save");
  btn.disabled = true;
  const beschriftung = btn.textContent;
  btn.textContent = "…";
  try {
    const { error } = await db.auth.updateUser({ password: neu });
    if (error) { fehler.textContent = error.message; return; }
    closePwDialog();
    showToast("Passwort geändert");
  } finally {
    btn.disabled = false;
    btn.textContent = beschriftung;
  }
}
$("change-pw-btn").addEventListener("click", openPwDialog);
$("pw-cancel").addEventListener("click", closePwDialog);
$("pw-save").addEventListener("click", savePw);
$("pw-overlay").addEventListener("click", (e) => { if (e.target.id === "pw-overlay") closePwDialog(); });
$("pw-again").addEventListener("keydown", (e) => { if (e.key === "Enter") savePw(); });

/* ---- E-Mail ändern ---- */
function openMailDialog() {
  $("mail-new").value = "";
  $("mail-error").textContent = "";
  $("mail-overlay").classList.add("open");
  setTimeout(() => $("mail-new").focus(), 60);
}
function closeMailDialog() { $("mail-overlay").classList.remove("open"); }

async function saveMail() {
  const email = $("mail-new").value.trim();
  const fehler = $("mail-error");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { fehler.textContent = "Das sieht nicht nach einer E-Mail-Adresse aus."; return; }
  if (user && email.toLowerCase() === (user.email || "").toLowerCase()) {
    fehler.textContent = "Das ist bereits deine Adresse."; return;
  }
  fehler.textContent = "";
  const btn = $("mail-save");
  btn.disabled = true;
  const beschriftung = btn.textContent;
  btn.textContent = "…";
  try {
    const { error } = await db.auth.updateUser({ email });
    if (error) { fehler.textContent = error.message; return; }
    closeMailDialog();
    showToast("Bestätigungs-Mails verschickt");
  } finally {
    btn.disabled = false;
    btn.textContent = beschriftung;
  }
}
$("change-email-btn").addEventListener("click", openMailDialog);
$("mail-cancel").addEventListener("click", closeMailDialog);
$("mail-save").addEventListener("click", saveMail);
$("mail-overlay").addEventListener("click", (e) => { if (e.target.id === "mail-overlay") closeMailDialog(); });
$("mail-new").addEventListener("keydown", (e) => { if (e.key === "Enter") saveMail(); });

/* ================= DATEN ================= */
async function enterApp() {
  $("auth-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("acct-email").textContent = user.email;
  await loadProfile();
  await loadSubs();
  await loadTodos();
  await loadNotes();
  await loadProjects();
  bindSettingsUI();
  renderAll();
  zeigeTabAn($("tab-" + activeTab));   // beim Start zieht die Übersicht einmal auf
  maybeNotifyDue();
  // Push-Anmeldung bei jedem Start auffrischen – iOS laesst sie still verfallen.
  registerPush().catch((e) => console.warn("Push-Anmeldung:", e));
}

async function loadProfile() {
  const { data } = await db.from("profiles").select("*").eq("user_id", user.id).maybeSingle();
  if (data) { profile = data; return; }
  const fresh = { user_id: user.id };
  const { data: created, error } = await db.from("profiles").insert(fresh).select().single();
  profile = created || { user_id: user.id, reminders_enabled: true, lead_days: 3, sort_by: "next_payment", currency: "EUR", monthly_budget: null };
  if (error) console.warn(error);
}

async function loadSubs() {
  const { data, error } = await db.from("subscriptions").select("*").order("next_payment");
  if (error) { showToast("Fehler beim Laden"); console.error(error); return; }
  // numeric/int kommen als String aus PostgREST – einmal beim Laden sauber machen
  subs = (data || []).map((s) => ({
    ...s,
    price: Number(s.price),
    cycle_months: Number(s.cycle_months),
    shared_with_count: Number(s.shared_with_count) || 1,
    vat_percent: Number(s.vat_percent) || 0
  }));
  const ids = subs.map((s) => s.id);
  history = {};
  if (ids.length) {
    const { data: h } = await db.from("price_history").select("*").in("subscription_id", ids).order("changed_at", { ascending: false });
    (h || []).forEach((row) => {
      (history[row.subscription_id] = history[row.subscription_id] || []).push(row);
    });
  }
}

async function loadTodos() {
  const { data, error } = await db.from("todos").select("*").order("due_date", { ascending: true, nullsFirst: false });
  if (error) { showToast("Fehler beim Laden"); console.error(error); return; }
  todos = data || [];
}

async function loadNotes() {
  const { data, error } = await db.from("notes").select("*").order("created_at", { ascending: false });
  if (error) { showToast("Fehler beim Laden"); console.error(error); return; }
  notes = data || [];
}

async function loadProjects() {
  const { data, error } = await db.from("projects").select("*").order("created_at", { ascending: false });
  if (error) { showToast("Fehler beim Laden"); console.error(error); return; }
  projects = data || [];
}

async function saveProfile(patch) {
  Object.assign(profile, patch);
  // upsert statt update: fehlt die Profilzeile, trifft ein update null Zeilen und meldet
  // trotzdem keinen Fehler – die Einstellung wäre beim nächsten Laden stillschweigend weg.
  const { error } = await db.from("profiles")
    .upsert({ ...profile, user_id: user.id, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) { showToast("Fehler beim Speichern"); console.error(error); }
}

/* ================= RENDERING ================= */
function activeSubs() { return subs.filter((s) => !s.archived); }

function renderAll() {
  renderBegruessung();
  renderSummary();
  renderBudget();
  renderOverdue();
  renderSavingsHint();
  renderAgenda();
  renderCatFilter();
  renderCards();
  renderArchive();
  renderTodos();
  renderNoteTagFilter();
  renderNotes();
  renderProjectKindFilter();
  renderProjects();
  // Statistik lebt jetzt im Abos-Tab
  if (activeTab === "abos") renderStats();
}

// Kopfzeile: Begrüßung nach Tageszeit statt „Stand: 27.07.2026".
// Bewusst nur Grußformeln – nichts, was den Zustand des Nutzers kommentiert
// („Noch wach?"). Die App begrüßt, sie beobachtet nicht.
// Zwischen 23 und 5 Uhr hat das Deutsche keine eigene Formel, dort steht „Hallo".
const GRUSS = { morgen: "Guten Morgen", tag: "Hallo", abend: "Guten Abend", nacht: "Hallo" };

// Die Grenzen sind auf Bedos Tag gelegt – er arbeitet regelmäßig bis nach
// Mitternacht, deshalb reicht der Abend bis 23 Uhr und die Nacht bis 5 Uhr.
function tageszeit(stunde) {
  if (stunde < 5) return "nacht";
  if (stunde < 11) return "morgen";
  if (stunde < 18) return "tag";
  if (stunde < 23) return "abend";
  return "nacht";
}

function renderBegruessung() {
  const jetzt = new Date();
  const name = (profile?.display_name || "").trim();
  const gruss = GRUSS[tageszeit(jetzt.getHours())];
  $("today-label").textContent = name ? `${gruss}, ${name}` : gruss;
  $("agenda-date").textContent = fmtDatumLang(jetzt);
}

function renderSummary() {
  const act = activeSubs();
  const monthly = act.reduce((sum, s) => sum + ownShareMonthly(s), 0);
  $("monthly-total").textContent = fmt(monthly);
  $("yearly-total").textContent = fmt(monthly * 12);
  $("open-todo-count").textContent = todos.filter((t) => !t.completed).length;
}

function renderBudget() {
  const bar = $("budget-bar");
  const b = Number(profile?.monthly_budget);
  if (!b || b <= 0) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const monthly = activeSubs().reduce((sum, s) => sum + ownShareMonthly(s), 0);
  const pct = Math.min(100, (monthly / b) * 100);
  $("budget-amount").textContent = `${fmt(monthly)} von ${fmt(b)}`;
  const fill = $("budget-fill");
  fill.style.width = pct + "%";
  fill.classList.toggle("over", monthly > b);
  $("budget-hint").classList.toggle("hidden", monthly <= b);
}

// Volle Monate seit einem Zeitstempel, kalendarisch statt über 30-Tage-Schritte.
function monateSeit(iso) {
  if (!iso) return 0;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  const heute = new Date();
  let m = (heute.getFullYear() - d.getFullYear()) * 12 + (heute.getMonth() - d.getMonth());
  if (heute.getDate() < d.getDate()) m--;   // angefangener Monat zählt nicht
  return Math.max(0, m);
}

function renderSavingsHint() {
  const banner = $("savings-banner");
  if (dismissedSavings) { banner.classList.add("hidden"); return; }
  // Früher lief das über updated_at – das springt aber bei jedem "Bezahlt" und
  // jeder Änderung hoch. Genau die Abos, die still vor sich hin laufen, wurden
  // dadurch nie erwischt. Maßgeblich ist, seit wann das Abo besteht.
  const lang = activeSubs()
    .map((s) => {
      const monate = monateSeit(s.created_at);
      return { s, monate, gezahlt: ownShareMonthly(s) * monate };
    })
    .filter((k) => k.monate >= 12)
    .sort((a, b) => b.gezahlt - a.gezahlt);

  if (!lang.length) { banner.classList.add("hidden"); return; }
  banner.classList.remove("hidden");
  const top = lang[0];
  const weitere = lang.length - 1;
  banner.innerHTML =
    `<span><strong>${esc(top.s.name)}</strong> läuft seit ${top.monate} Monaten – ` +
    `bisher rund <strong>${fmt(top.gezahlt)}</strong>.` +
    (weitere > 0
      ? weitere === 1
        ? " (ein weiteres Abo läuft ähnlich lang)"
        : ` (${weitere} weitere Abos laufen ähnlich lang)`
      : "") +
    `</span><button id="savings-close" aria-label="Ausblenden">${svgIcon("x")}</button>`;
  $("savings-close").addEventListener("click", () => { dismissedSavings = true; banner.classList.add("hidden"); });
}

/* ---- Überfällige Zahltermine ---- */
function overdueSubs() {
  const today = todayMidnight();
  return activeSubs().filter((s) => new Date(s.next_payment + "T00:00:00") < today);
}

// Nächster Termin, der nicht in der Vergangenheit liegt. Bei mehreren verpassten
// Zyklen wird so lange weitergezählt, bis das Datum wieder aktuell ist.
function nextDueDate(s) {
  const today = todayMidnight();
  let d = new Date(s.next_payment + "T00:00:00");
  const anchorDay = d.getDate();
  let guard = 0;
  while (d < today && guard++ < 1200) d = addMonths(d, s.cycle_months, anchorDay);
  return d;
}

function renderOverdue() {
  const box = $("overdue-banner");
  const list = overdueSubs();
  if (!list.length) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML =
    `<div class="ov-head">${list.length === 1 ? "Ein Zahltermin ist überfällig" : list.length + " Zahltermine sind überfällig"}</div>` +
    list.map((s) => `
      <div class="ov-row" data-id="${s.id}">
        <div class="ov-info">
          <div class="ov-name">${iconHTML(s)}<span>${esc(s.name)}</span></div>
          <div class="ov-sub">${fmt(bruttoPreis(s))} · war am ${fmtDate(new Date(s.next_payment + "T00:00:00"))}</div>
        </div>
        <div class="ov-actions">
          <button class="ov-paid">Bezahlt</button>
          <button class="ov-cancelled">Gekündigt</button>
        </div>
      </div>`).join("");
  box.querySelectorAll(".ov-row").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector(".ov-paid").addEventListener("click", () => markPaid(id));
    el.querySelector(".ov-cancelled").addEventListener("click", () => setArchived(id, true));
  });
}

async function markPaid(id) {
  const s = subs.find((x) => x.id === id);
  if (!s) return;
  const next = nextDueDate(s);
  const { error } = await db.from("subscriptions")
    .update({ next_payment: toDateStr(next), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) { showToast("Fehler beim Speichern"); console.error(error); return; }
  showToast(`${s.name}: nächste Zahlung ${fmtDate(next)}`);
  await loadSubs();
  renderAll();
}

function dueSubs() {
  if (!profile?.reminders_enabled) return [];
  const today = todayMidnight();
  const lead = profile.lead_days ?? 3;
  return activeSubs().filter((s) => {
    const diff = Math.round((new Date(s.next_payment + "T00:00:00") - today) / 864e5);
    return diff >= 0 && diff <= lead;
  });
}

/* ---- Agenda: was ansteht, egal welcher Art ---- */
// Fester 7-Tage-Blick, unabhängig von der Erinnerungs-Vorlaufzeit: die steuert
// nur, wann benachrichtigt wird – die Übersicht soll immer die Woche zeigen.
const AGENDA_TAGE = 7;

function kurzDatum(d) {
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function agendaItems() {
  const heute = todayMidnight();
  const grenze = new Date(heute);
  grenze.setDate(grenze.getDate() + AGENDA_TAGE);
  const items = [];
  activeSubs().forEach((s) => {
    const d = new Date(s.next_payment + "T00:00:00");
    // Überfällige Abos stehen schon oben im roten Panel mit Bezahlt/Gekündigt
    if (d >= heute && d <= grenze) items.push({ art: "abo", datum: d, s });
  });
  todos.forEach((t) => {
    if (t.completed || !t.due_date) return;
    const d = new Date(t.due_date + "T00:00:00");
    // Überfällige To-Dos bleiben stehen, bis sie erledigt sind
    if (d <= grenze) items.push({ art: "todo", datum: d, t });
  });
  projects.forEach((p) => {
    if (p.status === "fertig" || !p.due_date) return;
    const d = new Date(p.due_date + "T00:00:00");
    // Überfällige Deadlines bleiben stehen, bis der Status umgestellt wird
    if (d <= grenze) items.push({ art: "projekt", datum: d, p });
  });
  return items.sort((a, b) => a.datum - b.datum);
}

function agendaChip(dateStr, datum) {
  const badge = dateBadge(dateStr);
  const text = ["heute", "morgen", "überfällig"].includes(badge[1])
    ? badge[1]
    : `${kurzDatum(datum)} · ${badge[1]}`;
  // Feinere Ampel als auf den Karten: im 7-Tage-Fenster wäre sonst alles rot
  // und die Farbe hätte keine Aussage mehr.
  const diff = Math.round((datum - todayMidnight()) / 864e5);
  const ton = diff <= 1 ? "soon" : diff <= 3 ? "mid" : "far";
  return `<div class="next ${ton}">${text}</div>`;
}

function renderAgenda() {
  const box = $("agenda-container");
  if (!box) return;
  const items = agendaItems();
  if (!items.length) {
    box.innerHTML = `<div class="empty">In den nächsten ${AGENDA_TAGE} Tagen ist nichts fällig.</div>`;
    return;
  }
  box.innerHTML = items.map((it) => {
    if (it.art === "abo") {
      return `
      <div class="agenda-row" data-art="abo" data-id="${it.s.id}">
        ${iconHTML(it.s)}
        <div class="agenda-body">
          <div class="agenda-title">${esc(it.s.name)}</div>
          <div class="agenda-meta">Abo · ${fmt(bruttoPreis(it.s))}</div>
        </div>
        ${agendaChip(it.s.next_payment, it.datum)}
      </div>`;
    }
    if (it.art === "projekt") {
      return `
      <div class="agenda-row" data-art="projekt" data-id="${it.p.id}">
        <div class="icon">${svgIcon("folder")}</div>
        <div class="agenda-body">
          <div class="agenda-title">${esc(it.p.name)}</div>
          <div class="agenda-meta">Projekt · ${esc(it.p.status)}</div>
        </div>
        ${agendaChip(it.p.due_date, it.datum)}
      </div>`;
    }
    const zu = todoParentName(it.t);
    return `
    <div class="agenda-row" data-art="todo" data-id="${it.t.id}">
      <button class="todo-check" aria-label="Erledigt"></button>
      <div class="agenda-body">
        <div class="agenda-title">${tagTextHTML(it.t.title)}</div>
        <div class="agenda-meta">To-Do${zu ? " · " + esc(zu) : ""}</div>
      </div>
      ${agendaChip(it.t.due_date, it.datum)}
    </div>`;
  }).join("");
  box.querySelectorAll(".agenda-row").forEach((el) => {
    const id = el.dataset.id;
    if (el.dataset.art === "todo") {
      el.querySelector(".todo-check").addEventListener("click", (e) => { e.stopPropagation(); toggleTodo(id); });
      el.querySelector(".agenda-body").addEventListener("click", () => openTodoModal(id));
    } else if (el.dataset.art === "projekt") {
      el.addEventListener("click", () => openProjectModal(id));
    } else {
      el.addEventListener("click", () => openModal(id));
    }
  });
}

function renderCatFilter() {
  const row = $("cat-filter");
  const present = [...new Set(activeSubs().map((s) => s.category))];
  const cats = ["Alle", ...Object.keys(CATEGORIES).filter((c) => present.includes(c))];
  if (!cats.includes(activeCat)) activeCat = "Alle";
  row.innerHTML = cats.map((c) => `<button class="chip ${c === activeCat ? "active" : ""}" data-cat="${c}">${c}</button>`).join("");
  row.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { activeCat = b.dataset.cat; renderCatFilter(); renderCards(); }));
}

function sortSubs(list) {
  const by = profile?.sort_by || "next_payment";
  return [...list].sort((a, b) =>
    by === "name" ? a.name.localeCompare(b.name, "de")
    : by === "price" ? ownShareMonthly(b) - ownShareMonthly(a)
    : new Date(a.next_payment) - new Date(b.next_payment)
  );
}

function cardHTML(s, archivedView) {
  const next = new Date(s.next_payment + "T00:00:00");
  const badge = dateBadge(s.next_payment);
  const catColor = CATEGORIES[s.category] || CATEGORIES.Sonstige;
  // gespeichert wird die Gesamtzahl inkl. Nutzer – angezeigt werden nur die anderen
  const others = (s.shared_with_count || 1) - 1;
  // Teile einzeln escapen statt am Ende gesammelt – die Notiz darf Tag-Markup tragen
  const metaParts = [esc(`${fmt(bruttoPreis(s))} ${cycleText(s.cycle_months)}`)];
  // Netto ausweisen, sonst bleibt unklar, woher der krumme Betrag kommt
  if (s.vat_percent > 0) metaParts.push(esc(`${fmt(s.price)} + ${s.vat_percent} % MwSt`));
  if (s.note) metaParts.push(tagTextHTML(s.note));
  return `
  <div class="card ${archivedView ? "archived" : ""}" data-id="${s.id}">
    <div class="card-top">
      ${iconHTML(s)}
      <div class="info">
        <div class="name">${esc(s.name)}</div>
        <div class="meta">${metaParts.join(" · ")}</div>
        <span class="cat-tag" style="background:${catColor}22;color:${catColor};">${esc(s.category)}</span>
      </div>
      <div class="right">
        <div class="price">${fmt(ownShareMonthly(s))}/Monat</div>
        <div class="next ${badge[0]}">${fmtDate(next)} · ${badge[1]}</div>
      </div>
    </div>
    ${others > 0 ? `<div class="share-note">geteilt mit ${others} weiteren ${others === 1 ? "Person" : "Personen"} · gesamt ${fmt(bruttoPreis(s) / s.cycle_months)}/M</div>` : ""}
    <div class="card-actions">
      ${archivedView
        ? `<button class="unarchive">${svgIcon("undo")}Reaktivieren</button><button class="del">${svgIcon("x")}Endgültig löschen</button>`
        : `<button class="edit">${svgIcon("pen")}Bearbeiten</button><button class="archive">${svgIcon("archive")}Archivieren</button><button class="del">${svgIcon("x")}Löschen</button>`}
    </div>
  </div>`;
}

function renderCards() {
  const container = $("cards-container");
  let list = sortSubs(activeSubs());
  if (activeCat !== "Alle") list = list.filter((s) => s.category === activeCat);
  container.innerHTML = list.length
    ? list.map((s) => cardHTML(s, false)).join("")
    : `<div class="empty">Noch keine Abos${activeCat !== "Alle" ? " in dieser Kategorie" : ""} – tipp unten rechts auf „+“.</div>`;
  container.querySelectorAll(".card").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector(".edit")?.addEventListener("click", () => openModal(id));
    el.querySelector(".archive")?.addEventListener("click", () => setArchived(id, true));
    el.querySelector(".del")?.addEventListener("click", () => deleteSub(id));
  });
}

function renderArchive() {
  const container = $("archive-container");
  const list = subs.filter((s) => s.archived);
  // Kein eigener Tab mehr: sitzt unten im Abos-Tab und taucht nur auf, wenn es was gibt
  $("archive-head").classList.toggle("hidden", !list.length);
  container.innerHTML = list.map((s) => cardHTML(s, true)).join("");
  container.querySelectorAll(".card").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector(".unarchive")?.addEventListener("click", () => setArchived(id, false));
    el.querySelector(".del")?.addEventListener("click", () => deleteSub(id));
  });
}

/* ================= STATISTIK ================= */
function renderStats() {
  // Donut nach Kategorie
  const byCat = {};
  activeSubs().forEach((s) => { byCat[s.category] = (byCat[s.category] || 0) + ownShareMonthly(s); });
  const total = Object.values(byCat).reduce((a, b) => a + b, 0);
  const svg = $("donut");
  const legend = $("donut-legend");
  svg.innerHTML = "";
  legend.innerHTML = "";
  if (!total) { legend.innerHTML = `<div class="li">Keine aktiven Abos.</div>`; return; }
  const R = 58, C = 75, circ = 2 * Math.PI * R;
  let offset = 0;
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([cat, val]) => {
    const frac = val / total;
    const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    el.setAttribute("cx", C); el.setAttribute("cy", C); el.setAttribute("r", R);
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", CATEGORIES[cat] || "#888");
    el.setAttribute("stroke-width", "20");
    el.setAttribute("stroke-dasharray", `${frac * circ} ${circ}`);
    el.setAttribute("stroke-dashoffset", String(-offset * circ));
    el.setAttribute("transform", `rotate(-90 ${C} ${C})`);
    svg.appendChild(el);
    offset += frac;
    legend.innerHTML += `<div class="li"><span class="dot" style="background:${CATEGORIES[cat]}"></span>${esc(cat)}<span class="amt">${fmt(val)} · ${Math.round(frac * 100)} %</span></div>`;
  });
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", C); label.setAttribute("y", C + 5);
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("fill", "#f0f1f4");
  label.setAttribute("font-size", "15");
  label.setAttribute("font-weight", "700");
  label.textContent = fmt(total);
  svg.appendChild(label);

  // Balken: tatsächliche Zahlungen der nächsten 6 Monate (eigener Anteil)
  const bars = $("bars");
  const months = [];
  const now = todayMidnight();
  for (let i = 0; i < 6; i++) {
    const m = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push({ key: `${m.getFullYear()}-${m.getMonth()}`, label: m.toLocaleDateString("de-DE", { month: "short" }), sum: 0 });
  }
  const horizon = new Date(now.getFullYear(), now.getMonth() + 6, 1);
  activeSubs().forEach((s) => {
    let d = new Date(s.next_payment + "T00:00:00");
    const anchorDay = d.getDate();
    while (d < horizon) {
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const bucket = months.find((m) => m.key === key);
      if (bucket) bucket.sum += bruttoPreis(s) / (s.shared_with_count || 1);
      d = addMonths(d, s.cycle_months, anchorDay);
    }
  });
  const max = Math.max(...months.map((m) => m.sum), 1);
  bars.innerHTML = months.map((m) =>
    `<div class="bar-col"><div class="bar" style="height:${Math.max(4, (m.sum / max) * 100)}%" title="${fmt(m.sum)}"></div><div class="bl">${m.label}<br>${m.sum ? fmt(m.sum) : "–"}</div></div>`
  ).join("");
}

/* ================= CRUD ================= */
function openModal(id) {
  editingId = id || null;
  $("modal-title").textContent = id ? "Abo bearbeiten" : "Abo hinzufügen";
  $("f-category").innerHTML = Object.keys(CATEGORIES).map((c) => `<option value="${c}">${c}</option>`).join("");
  const histEl = $("f-history");
  histEl.classList.add("hidden");
  if (id) {
    const s = subs.find((x) => x.id === id);
    $("f-icon").value = s.icon || "";
    $("f-name").value = s.name;
    $("f-price").value = s.price;
    $("f-next").value = s.next_payment;
    $("f-note").value = s.note || "";
    $("f-shared").value = Math.max(0, (s.shared_with_count || 1) - 1);
    $("f-vat").value = String(s.vat_percent || 0);
    $("f-category").value = s.category;
    if ([1, 3, 6, 12].includes(s.cycle_months)) {
      $("f-cycle").value = String(s.cycle_months);
      $("f-custom-wrap").classList.add("hidden");
    } else {
      $("f-cycle").value = "custom";
      $("f-custom-wrap").classList.remove("hidden");
      $("f-custom-months").value = s.cycle_months;
    }
    const h = history[id] || [];
    if (h.length) {
      histEl.classList.remove("hidden");
      histEl.innerHTML = "<strong>Preis-Historie:</strong>" + h.map((row) =>
        `<div>${fmtDate(new Date(row.changed_at))}: ${fmt(Number(row.old_price))} → ${fmt(Number(row.new_price))}</div>`
      ).join("");
    }
  } else {
    ["f-icon", "f-name", "f-price", "f-next", "f-note"].forEach((i) => $(i).value = "");
    $("f-shared").value = 0;
    $("f-vat").value = "0";
    $("f-cycle").value = "1";
    $("f-category").value = "Sonstige";
    $("f-custom-wrap").classList.add("hidden");
  }
  refreshPreview();
  refreshVatHint();
  $("overlay").classList.add("open");
  setTimeout(() => $("f-name").focus(), 60);
}
function closeModal() { $("overlay").classList.remove("open"); editingId = null; }

/* Zeigt live, wie das Abo in der Liste aussehen wird */
function refreshPreview() {
  $("f-preview").innerHTML = iconHTML({
    icon: $("f-icon").value,
    name: $("f-name").value,
    category: $("f-category").value
  });
}
/* Rechnet sofort vor, was am Ende abgebucht wird – sonst tippt man
   90 ein und sieht erst nach dem Speichern, ob 107,10 herauskommt. */
function refreshVatHint() {
  const el = $("f-vat-hint");
  const netto = parseFloat($("f-price").value);
  const satz = Number($("f-vat").value) || 0;
  if (!satz || isNaN(netto)) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = `${fmt(netto)} + ${satz} % MwSt = <strong>${fmt(netto * (1 + satz / 100))}</strong>`;
}
$("f-price").addEventListener("input", refreshVatHint);
$("f-vat").addEventListener("change", refreshVatHint);

$("f-icon").addEventListener("input", refreshPreview);
$("f-category").addEventListener("change", refreshPreview);
$("f-name").addEventListener("input", () => {
  const b = brandFor($("f-name").value);
  // Kategorie nur vorschlagen, solange der Nutzer selbst noch keine gewählt hat
  if (b && $("f-category").value === "Sonstige") $("f-category").value = b.cat;
  refreshPreview();
});

$("f-cycle").addEventListener("change", (e) => $("f-custom-wrap").classList.toggle("hidden", e.target.value !== "custom"));
$("add-btn").addEventListener("click", () => activeTab === "projekte" ? openProjectModal(null) : openModal(null));
$("cancel-btn").addEventListener("click", closeModal);
$("overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeModal(); });

$("submit-btn").addEventListener("click", async () => {
  const name = $("f-name").value.trim();
  const price = parseFloat($("f-price").value);
  const next = $("f-next").value;
  if (!name || isNaN(price) || !next) { showToast("Bitte Name, Preis und Datum ausfüllen"); return; }
  let cycle = $("f-cycle").value === "custom" ? parseInt($("f-custom-months").value, 10) : parseInt($("f-cycle").value, 10);
  if (!cycle || cycle < 1) cycle = 1;
  const row = {
    name,
    icon: $("f-icon").value.trim() || "📦",
    category: $("f-category").value,
    price,
    // 0 = Preis ist schon der Endbetrag, sonst kommt der Satz obendrauf
    vat_percent: Number($("f-vat").value) || 0,
    cycle_months: cycle,
    next_payment: next,
    note: $("f-note").value.trim() || null,
    // Eingabe zählt die anderen, gespeichert wird inkl. Nutzer (DB verlangt >= 1)
    shared_with_count: Math.max(0, parseInt($("f-shared").value, 10) || 0) + 1,
    updated_at: new Date().toISOString()
  };
  $("submit-btn").disabled = true;
  try {
    if (editingId) {
      const old = subs.find((s) => s.id === editingId);
      if (old && Number(old.price) !== price) {
        await db.from("price_history").insert({ subscription_id: editingId, user_id: user.id, old_price: old.price, new_price: price });
      }
      const { error } = await db.from("subscriptions").update(row).eq("id", editingId);
      if (error) throw error;
      showToast("Aktualisiert");
    } else {
      const { error } = await db.from("subscriptions").insert({ ...row, user_id: user.id });
      if (error) throw error;
      showToast("Hinzugefügt");
    }
    closeModal();
    await loadSubs();
    renderAll();
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    $("submit-btn").disabled = false;
  }
});

async function setArchived(id, archived) {
  const { error } = await db.from("subscriptions").update({ archived, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) { showToast(archived ? "Fehler beim Archivieren" : "Fehler beim Reaktivieren"); return; }
  showToast(archived ? "Archiviert" : "Reaktiviert");
  await loadSubs();
  renderAll();
}

async function deleteSub(id) {
  const s = subs.find((x) => x.id === id);
  if (!s) return;
  if (!confirm(`„${s.name}“ wirklich endgültig löschen?${s.archived ? "" : "\n\nTipp: Mit „Archivieren“ bleibt es in der Historie."}`)) return;
  const { error } = await db.from("subscriptions").delete().eq("id", id);
  if (error) { showToast("Fehler beim Löschen"); return; }
  showToast("Gelöscht");
  await loadSubs();
  renderAll();
}

/* ================= TO-DOS ================= */
// Name des verknüpften Projekts oder Abos – ein To-Do hat höchstens eines von beiden
function todoParentName(t) {
  if (t.project_id) return projects.find((p) => p.id === t.project_id)?.name || null;
  if (t.subscription_id) return subs.find((s) => s.id === t.subscription_id)?.name || null;
  return null;
}

function todoRowHTML(t) {
  const badge = dateBadge(t.due_date);
  const zu = todoParentName(t);
  const metaParts = [esc(t.due_date ? `${fmtDate(new Date(t.due_date + "T00:00:00"))} · ${badge[1]}` : "ohne Termin")];
  if (zu) metaParts.push(esc(zu));
  return `
  <div class="todo-row ${t.completed ? "done" : ""}" data-id="${t.id}">
    <button class="todo-check ${t.completed ? "checked" : ""}${t.id === ebenAbgehakt ? " just" : ""}" aria-label="Erledigt"></button>
    <div class="todo-body">
      <div class="todo-title">${tagTextHTML(t.title)}</div>
      <div class="todo-meta ${t.completed ? "" : badge[0]}">${metaParts.join(" · ")}</div>
    </div>
  </div>`;
}

function sortTodos(list) {
  return [...list].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;   // offene zuerst
    if (a.completed) return new Date(b.completed_at) - new Date(a.completed_at);
    if (!a.due_date && !b.due_date) return 0;
    if (!a.due_date) return 1;                                      // ohne Termin ans Ende
    if (!b.due_date) return -1;
    return new Date(a.due_date) - new Date(b.due_date);
  });
}

function renderTodos() {
  const container = $("todos-container");
  if (!container) return;
  // Erledigte bleiben nur bis Tagesende sichtbar (Bestätigung fürs Abhaken),
  // damit die Liste nicht mit alten Häkchen vollläuft.
  const heute = toDateStr(todayMidnight());
  const visible = todos.filter((t) => !t.completed || (t.completed_at && toDateStr(new Date(t.completed_at)) === heute));
  const sorted = sortTodos(visible);
  container.innerHTML = sorted.length
    ? sorted.map(todoRowHTML).join("")
    : `<div class="empty">Noch keine To-Dos – trag oben etwas ein.</div>`;
  container.querySelectorAll(".todo-row").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector(".todo-check").addEventListener("click", (e) => { e.stopPropagation(); toggleTodo(id); });
    el.querySelector(".todo-body").addEventListener("click", () => openTodoModal(id));
  });
}

async function quickAddTodo() {
  const titleEl = $("todo-quick-title");
  const dateEl = $("todo-quick-date");
  const title = titleEl.value.trim();
  if (!title) return;
  titleEl.disabled = true;
  try {
    const { error } = await db.from("todos").insert({ user_id: user.id, title, due_date: dateEl.value || null });
    if (error) throw error;
    titleEl.value = "";
    dateEl.value = "";
    await loadTodos();
    renderAll();
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    titleEl.disabled = false;
    titleEl.focus();
  }
}
$("todo-quick-add").addEventListener("click", quickAddTodo);
$("todo-quick-title").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAddTodo(); });

async function toggleTodo(id) {
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  const completed = !t.completed;
  const patch = { completed, completed_at: completed ? new Date().toISOString() : null, updated_at: new Date().toISOString() };
  Object.assign(t, patch);   // optimistisch: sofort umschalten, nicht auf den Server warten
  ebenAbgehakt = completed ? id : null;
  clearTimeout(abhakTimer);
  abhakTimer = setTimeout(() => { ebenAbgehakt = null; }, 600);
  renderAll();
  const { error } = await db.from("todos").update(patch).eq("id", id);
  if (error) { showToast("Fehler beim Speichern"); console.error(error); await loadTodos(); renderAll(); }
}

async function deleteTodo(id) {
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`„${t.title}“ wirklich löschen?`)) return;
  const { error } = await db.from("todos").delete().eq("id", id);
  if (error) { showToast("Fehler beim Löschen"); return; }
  closeTodoModal();
  showToast("Gelöscht");
  await loadTodos();
  renderAll();
}

function openTodoModal(id) {
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  editingTodoId = id;
  $("todo-f-title").value = t.title;
  $("todo-f-date").value = t.due_date || "";
  $("todo-f-desc").value = t.description || "";
  // Ein To-Do kann zu einem Projekt ODER einem Abo gehören. Ein Select mit
  // Gruppen statt zwei Feldern – die Werte tragen ein Präfix (p:/s:), gespeichert
  // wird weiter in getrennten Spalten.
  const projektOptionen = sortProjects(projects)
    .map((p) => `<option value="p:${p.id}">${esc(p.name)}</option>`).join("");
  const aboOptionen = activeSubs()
    .map((s) => `<option value="s:${s.id}">${esc(s.name)}</option>`).join("");
  $("todo-f-sub").innerHTML = `<option value="">— nichts —</option>` +
    (projektOptionen ? `<optgroup label="Projekte">${projektOptionen}</optgroup>` : "") +
    (aboOptionen ? `<optgroup label="Abos">${aboOptionen}</optgroup>` : "");
  $("todo-f-sub").value = t.project_id ? "p:" + t.project_id : t.subscription_id ? "s:" + t.subscription_id : "";
  $("todo-overlay").classList.add("open");
  setTimeout(() => $("todo-f-title").focus(), 60);
}
function closeTodoModal() { $("todo-overlay").classList.remove("open"); editingTodoId = null; }

async function saveTodoModal() {
  const title = $("todo-f-title").value.trim();
  if (!title) { showToast("Bitte einen Titel eingeben"); return; }
  const zu = $("todo-f-sub").value;   // "", "p:<id>" oder "s:<id>"
  const patch = {
    title,
    due_date: $("todo-f-date").value || null,
    description: $("todo-f-desc").value.trim() || null,
    project_id: zu.startsWith("p:") ? zu.slice(2) : null,
    subscription_id: zu.startsWith("s:") ? zu.slice(2) : null,
    updated_at: new Date().toISOString()
  };
  const btn = $("todo-save-btn");
  btn.disabled = true;
  try {
    const { error } = await db.from("todos").update(patch).eq("id", editingTodoId);
    if (error) throw error;
    closeTodoModal();
    showToast("Gespeichert");
    await loadTodos();
    renderAll();
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    btn.disabled = false;
  }
}
$("todo-save-btn").addEventListener("click", saveTodoModal);
$("todo-cancel-btn").addEventListener("click", closeTodoModal);
$("todo-delete-btn").addEventListener("click", () => deleteTodo(editingTodoId));
$("todo-overlay").addEventListener("click", (e) => { if (e.target.id === "todo-overlay") closeTodoModal(); });

/* ================= NOTIZEN ================= */
// Tag-Erkennung (extractTags/tagTextHTML) liegt bei den Helpers – sie gilt app-weit.

function renderNoteTagFilter() {
  const row = $("note-tag-filter");
  if (!row) return;
  const allTags = [...new Set(notes.flatMap((n) => extractTags(n.content)))].sort();
  if (!allTags.length) { row.classList.add("hidden"); activeNoteTag = "Alle"; return; }
  row.classList.remove("hidden");
  const tags = ["Alle", ...allTags];
  if (!tags.includes(activeNoteTag)) activeNoteTag = "Alle";
  row.innerHTML = tags.map((t) =>
    `<button class="chip ${t === activeNoteTag ? "active" : ""}" data-tag="${esc(t)}">${t === "Alle" ? "Alle" : "#" + esc(t)}</button>`
  ).join("");
  row.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    activeNoteTag = b.dataset.tag;
    renderNoteTagFilter();
    renderNotes();
  }));
}

function noteCardHTML(n) {
  return `
  <div class="note-card" data-id="${n.id}">
    <div class="note-content">${tagTextHTML(n.content)}</div>
    <div class="note-meta">${fmtDateTime(new Date(n.created_at))}</div>
  </div>`;
}

function renderNotes() {
  const container = $("notes-container");
  if (!container) return;
  let list = [...notes].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (activeNoteTag !== "Alle") list = list.filter((n) => extractTags(n.content).includes(activeNoteTag));
  container.innerHTML = list.length
    ? list.map(noteCardHTML).join("")
    : `<div class="empty">${activeNoteTag !== "Alle" ? "Keine Notizen mit diesem Tag." : "Noch keine Notizen – trag oben etwas ein."}</div>`;
  container.querySelectorAll(".note-card").forEach((el) => {
    el.addEventListener("click", () => openNoteModal(el.dataset.id));
  });
}

async function quickAddNote() {
  const el = $("note-quick-text");
  const content = el.value.trim();
  if (!content) return;
  el.disabled = true;
  try {
    const { error } = await db.from("notes").insert({ user_id: user.id, content });
    if (error) throw error;
    el.value = "";
    el.style.height = "";
    await loadNotes();
    renderNoteTagFilter();
    renderNotes();
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    el.disabled = false;
    el.focus();
  }
}
$("note-quick-add").addEventListener("click", quickAddNote);
$("note-quick-text").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") quickAddNote(); });
// Waechst mit dem Text mit, bis max-height greift – dann eigenes Scrollen (siehe CSS)
$("note-quick-text").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = e.target.scrollHeight + "px";
});

function openNoteModal(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  editingNoteId = id;
  $("note-f-content").value = n.content;
  $("note-overlay").classList.add("open");
  setTimeout(() => {
    const ta = $("note-f-content");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 60);
}
function closeNoteModal() { $("note-overlay").classList.remove("open"); editingNoteId = null; }

async function saveNoteModal() {
  const content = $("note-f-content").value.trim();
  if (!content) { showToast("Notiz ist leer"); return; }
  const btn = $("note-save-btn");
  btn.disabled = true;
  try {
    const { error } = await db.from("notes").update({ content, updated_at: new Date().toISOString() }).eq("id", editingNoteId);
    if (error) throw error;
    closeNoteModal();
    showToast("Gespeichert");
    await loadNotes();
    renderNoteTagFilter();
    renderNotes();
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    btn.disabled = false;
  }
}

async function deleteNote(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  if (!confirm("Notiz wirklich löschen?")) return;
  const { error } = await db.from("notes").delete().eq("id", id);
  if (error) { showToast("Fehler beim Löschen"); return; }
  closeNoteModal();
  showToast("Gelöscht");
  await loadNotes();
  renderNoteTagFilter();
  renderNotes();
}
$("note-save-btn").addEventListener("click", saveNoteModal);
$("note-cancel-btn").addEventListener("click", closeNoteModal);
$("note-delete-btn").addEventListener("click", () => deleteNote(editingNoteId));
$("note-overlay").addEventListener("click", (e) => { if (e.target.id === "note-overlay") closeNoteModal(); });

/* ================= PROJEKTE ================= */
const PROJECT_STATUS_CLASS = {
  "offen": "st-offen",
  "in Arbeit": "st-arbeit",
  "wartet": "st-wartet",
  "fertig": "st-fertig"
};

function offeneTodosZu(projectId) {
  return todos.filter((t) => t.project_id === projectId && !t.completed).length;
}

function renderProjectKindFilter() {
  const row = $("project-kind-filter");
  if (!row) return;
  const present = [...new Set(projects.map((p) => p.kind))];
  const kinds = ["Alle", ...["Kunde", "Eigenes", "Sonstiges"].filter((k) => present.includes(k))];
  if (!kinds.includes(activeProjectKind)) activeProjectKind = "Alle";
  // Chips erst ab zwei echten Arten – ein einziger Filter wäre nur Deko
  row.classList.toggle("hidden", kinds.length <= 2);
  row.innerHTML = kinds.map((k) =>
    `<button class="chip ${k === activeProjectKind ? "active" : ""}" data-kind="${k}">${k === "Kunde" ? "Kunden" : k === "Eigenes" ? "Eigene" : k === "Sonstiges" ? "Sonstige" : k}</button>`
  ).join("");
  row.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    activeProjectKind = b.dataset.kind;
    renderProjectKindFilter();
    renderProjects();
  }));
}

function sortProjects(list) {
  return [...list].sort((a, b) => {
    const aFertig = a.status === "fertig", bFertig = b.status === "fertig";
    if (aFertig !== bFertig) return aFertig ? 1 : -1;      // Fertiges ans Ende
    if (!!a.due_date !== !!b.due_date) return a.due_date ? -1 : 1;  // Deadlines zuerst
    if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
    return a.name.localeCompare(b.name, "de");
  });
}

function projectCardHTML(p) {
  const metaParts = [p.kind];
  if (p.due_date && p.status !== "fertig") {
    metaParts.push(`Deadline ${kurzDatum(new Date(p.due_date + "T00:00:00"))} (${dateBadge(p.due_date)[1]})`);
  }
  const offen = offeneTodosZu(p.id);
  if (offen > 0) metaParts.push(offen === 1 ? "1 To-Do offen" : `${offen} To-Dos offen`);
  // Link ohne Protokoll anzeigen – der Klick öffnet trotzdem die volle Adresse
  const linkText = (p.link || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `
  <div class="project-card ${p.status === "fertig" ? "done" : ""}" data-id="${p.id}">
    <div class="project-top">
      <div class="project-name">${esc(p.name)}</div>
      <span class="status-chip ${PROJECT_STATUS_CLASS[p.status] || "st-offen"}">${esc(p.status)}</span>
    </div>
    <div class="project-meta">${esc(metaParts.join(" · "))}</div>
    ${p.note ? `<div class="project-note">${tagTextHTML(p.note)}</div>` : ""}
    ${p.link ? `<a class="project-link" href="${esc(p.link)}" target="_blank" rel="noopener">${svgIcon("link")}${esc(linkText)}</a>` : ""}
  </div>`;
}

function renderProjects() {
  const container = $("projects-container");
  if (!container) return;
  let list = sortProjects(projects);
  if (activeProjectKind !== "Alle") list = list.filter((p) => p.kind === activeProjectKind);
  container.innerHTML = list.length
    ? list.map(projectCardHTML).join("")
    : `<div class="empty">Noch keine Projekte${activeProjectKind !== "Alle" ? " dieser Art" : ""} – tipp unten rechts auf „+“.</div>`;
  container.querySelectorAll(".project-card").forEach((el) => {
    el.addEventListener("click", () => openProjectModal(el.dataset.id));
    // Der Link soll die Seite öffnen, nicht das Modal
    el.querySelector(".project-link")?.addEventListener("click", (e) => e.stopPropagation());
  });
}

function openProjectModal(id) {
  editingProjectId = id || null;
  $("project-modal-title").textContent = id ? "Projekt bearbeiten" : "Projekt anlegen";
  // Bei Neuanlage gibt es nichts zu löschen
  $("project-delete-btn").classList.toggle("hidden", !id);
  if (id) {
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    $("project-f-name").value = p.name;
    $("project-f-kind").value = p.kind;
    $("project-f-status").value = p.status;
    $("project-f-date").value = p.due_date || "";
    $("project-f-link").value = p.link || "";
    $("project-f-note").value = p.note || "";
  } else {
    $("project-f-name").value = "";
    $("project-f-kind").value = "Eigenes";
    $("project-f-status").value = "offen";
    $("project-f-date").value = "";
    $("project-f-link").value = "";
    $("project-f-note").value = "";
  }
  $("project-overlay").classList.add("open");
  setTimeout(() => $("project-f-name").focus(), 60);
}
function closeProjectModal() { $("project-overlay").classList.remove("open"); editingProjectId = null; }

async function saveProjectModal() {
  const name = $("project-f-name").value.trim();
  if (!name) { showToast("Bitte einen Namen eingeben"); return; }
  let link = $("project-f-link").value.trim();
  // "pixelsaray.vercel.app" eingetippt soll trotzdem klickbar sein
  if (link && !/^https?:\/\//i.test(link)) link = "https://" + link;
  const row = {
    name,
    kind: $("project-f-kind").value,
    status: $("project-f-status").value,
    due_date: $("project-f-date").value || null,
    link: link || null,
    note: $("project-f-note").value.trim() || null,
    updated_at: new Date().toISOString()
  };
  const btn = $("project-save-btn");
  btn.disabled = true;
  try {
    if (editingProjectId) {
      const { error } = await db.from("projects").update(row).eq("id", editingProjectId);
      if (error) throw error;
      showToast("Gespeichert");
    } else {
      const { error } = await db.from("projects").insert({ ...row, user_id: user.id });
      if (error) throw error;
      showToast("Projekt angelegt");
    }
    closeProjectModal();
    await loadProjects();
    renderAll();
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    btn.disabled = false;
  }
}

async function deleteProject(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  const offen = offeneTodosZu(id);
  if (!confirm(`„${p.name}“ wirklich löschen?${offen ? `\n\n${offen === 1 ? "Das verknüpfte To-Do bleibt" : offen + " verknüpfte To-Dos bleiben"} bestehen, nur die Verknüpfung fällt weg.` : ""}`)) return;
  const { error } = await db.from("projects").delete().eq("id", id);
  if (error) { showToast("Fehler beim Löschen"); return; }
  closeProjectModal();
  showToast("Gelöscht");
  await Promise.all([loadProjects(), loadTodos()]);   // To-Dos neu: project_id wurde serverseitig genullt
  renderAll();
}
$("project-save-btn").addEventListener("click", saveProjectModal);
$("project-cancel-btn").addEventListener("click", closeProjectModal);
$("project-delete-btn").addEventListener("click", () => deleteProject(editingProjectId));
$("project-overlay").addEventListener("click", (e) => { if (e.target.id === "project-overlay") closeProjectModal(); });

/* ================= TAG-ANSICHT ================= */
// Ein Tipp auf ein #tag – egal wo – zeigt alles, was es trägt: Projekte,
// To-Dos, Abos, Notizen. Das ist die Querverbindung zwischen den Bausteinen.

function closeTagView() { $("tag-overlay").classList.remove("open"); }

// Aus der Sammelansicht heraus direkt ins jeweilige Bearbeiten-Fenster
function openTagRow(art, id) {
  closeTagView();
  if (art === "projekt") openProjectModal(id);
  else if (art === "abo") openModal(id);
  else if (art === "todo") openTodoModal(id);
  else if (art === "note") openNoteModal(id);
}

function tagRowHTML(art, id, symbol, titelHTML, rechts) {
  return `
  <div class="tag-row" data-art="${art}" data-id="${id}">
    <div class="tag-row-symbol">${symbol}</div>
    <div class="tag-row-body">${titelHTML}</div>
    ${rechts ? `<div class="tag-row-rechts">${rechts}</div>` : ""}
  </div>`;
}

function openTagView(tag) {
  $("tag-view-title").textContent = "#" + tag;
  const secs = [];

  const projekte = projects.filter((p) => extractTags(p.note).includes(tag));
  if (projekte.length) {
    secs.push(`<div class="tag-sec-head">Projekte</div>` + projekte.map((p) =>
      tagRowHTML("projekt", p.id, svgIcon("folder"), esc(p.name),
        `<span class="status-chip ${PROJECT_STATUS_CLASS[p.status] || "st-offen"}">${esc(p.status)}</span>`)
    ).join(""));
  }

  const offen = todos.filter((t) => !t.completed && todoTags(t).includes(tag));
  const erledigt = todos.filter((t) => t.completed && todoTags(t).includes(tag)).length;
  if (offen.length || erledigt) {
    secs.push(`<div class="tag-sec-head">To-Dos</div>` +
      offen.map((t) => tagRowHTML("todo", t.id, svgIcon("circle"), esc(t.title),
        t.due_date ? `<span class="next ${dateBadge(t.due_date)[0]}">${dateBadge(t.due_date)[1]}</span>` : "")).join("") +
      (erledigt ? `<div class="tag-sec-hint">${erledigt === 1 ? "1 erledigtes To-Do" : erledigt + " erledigte To-Dos"}</div>` : ""));
  }

  const abos = subs.filter((s) => extractTags(s.note).includes(tag));
  if (abos.length) {
    secs.push(`<div class="tag-sec-head">Abos</div>` + abos.map((s) =>
      tagRowHTML("abo", s.id, svgIcon("card"), esc(s.name) + (s.archived ? ` <span class="tag-dim">(archiviert)</span>` : ""),
        esc(`${fmt(ownShareMonthly(s))}/M`))
    ).join(""));
  }

  const notizen = notes.filter((n) => extractTags(n.content).includes(tag));
  if (notizen.length) {
    secs.push(`<div class="tag-sec-head">Notizen</div>` + notizen.map((n) => {
      const zeile = n.content.split("\n")[0].slice(0, 60);
      return tagRowHTML("note", n.id, svgIcon("note"), esc(zeile), esc(kurzDatum(new Date(n.created_at))));
    }).join(""));
  }

  const body = $("tag-view-body");
  body.innerHTML = secs.join("") || `<div class="empty">Nichts weiter mit diesem Tag.</div>`;
  body.querySelectorAll(".tag-row").forEach((el) =>
    el.addEventListener("click", () => openTagRow(el.dataset.art, el.dataset.id)));
  $("tag-overlay").classList.add("open");
}

$("tag-close-btn").addEventListener("click", closeTagView);
$("tag-overlay").addEventListener("click", (e) => { if (e.target.id === "tag-overlay") closeTagView(); });

// Ein Klick-Fänger für alle Tags, in der Capture-Phase: er greift, BEVOR die
// Karte darunter ihr Bearbeiten-Fenster öffnet.
document.addEventListener("click", (e) => {
  const el = e.target.closest?.(".tag-inline");
  if (!el || !el.dataset.tag) return;
  e.preventDefault();
  e.stopPropagation();
  openTagView(el.dataset.tag);
}, true);

/* ================= EINSTELLUNGEN ================= */
function bindSettingsUI() {
  $("set-name").value = profile.display_name || "";
  $("set-reminders").checked = !!profile.reminders_enabled;
  $("set-leaddays").value = String(profile.lead_days ?? 3);
  $("set-sort").value = profile.sort_by || "next_payment";
  $("set-currency").value = profile.currency || "EUR";
  $("set-budget").value = profile.monthly_budget ?? "";

  // Leeres Feld = kein Name; dann grüßt die App eben ohne Anrede
  $("set-name").onchange = (e) => {
    const name = e.target.value.trim();
    e.target.value = name;
    saveProfile({ display_name: name || null });
    renderBegruessung();
  };
  $("set-reminders").onchange = (e) => saveProfile({ reminders_enabled: e.target.checked });
  $("set-leaddays").onchange = (e) => saveProfile({ lead_days: parseInt(e.target.value, 10) });
  $("set-sort").onchange = (e) => { saveProfile({ sort_by: e.target.value }); renderCards(); };
  $("set-currency").onchange = (e) => { saveProfile({ currency: e.target.value }); renderAll(); };
  $("set-budget").onchange = (e) => {
    const v = e.target.value === "" ? null : Math.max(0, parseFloat(e.target.value));
    saveProfile({ monthly_budget: v });
    renderBudget();
  };
  $("set-push").onclick = requestPush;
  $("set-push-test").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const vorher = btn.textContent;
    btn.textContent = "…";
    try {
      // Erst sicherstellen, dass dieses Geraet ueberhaupt angemeldet ist
      if (Notification.permission !== "granted") { await requestPush(); }
      await registerPush();
      const r = await pushFn("test");
      showToast(r.verschickt > 0
        ? `Probe an ${r.verschickt} Gerät${r.verschickt === 1 ? "" : "e"} geschickt`
        : "Kein Gerät angemeldet – erst „Aktivieren“ drücken");
    } catch (err) {
      console.warn(err);
      showToast("Test fehlgeschlagen: " + (err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = vorher;
    }
  };
}

/* ================= TABS ================= */
document.querySelectorAll(".tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b === btn));
    ["home", "projekte", "abos", "todos", "notes", "settings"].forEach((t) => $("tab-" + t).classList.toggle("hidden", t !== activeTab));
    // Der +-Knopf legt je nach Tab ein Abo oder Projekt an –
    // To-Dos und Notizen haben ihre eigene Schnelleingabe
    $("add-btn").classList.toggle("hidden", activeTab !== "abos" && activeTab !== "projekte");
    if (activeTab === "abos") renderStats();
    zeigeTabAn($("tab-" + activeTab));
  });
});

// Der neue Tab blendet einmal gestaffelt auf. Die Klasse fliegt danach wieder
// raus, damit späteres Neuzeichnen (Speichern, Abhaken) die Liste nicht erneut
// durchtanzen lässt – Bewegung soll Handlung heißen, nicht Hintergrundrauschen.
let tabAnimTimer = null;
function zeigeTabAn(sec) {
  clearTimeout(tabAnimTimer);
  document.querySelectorAll(".tab-in").forEach((el) => el.classList.remove("tab-in"));
  void sec.offsetWidth;   // Neustart erzwingen, falls derselbe Tab erneut kommt
  sec.classList.add("tab-in");
  tabAnimTimer = setTimeout(() => sec.classList.remove("tab-in"), 700);
}

/* ================= KALENDER-EXPORT ================= */
// In ICS-Textfeldern sind \ ; , und Zeilenumbrüche Sonderzeichen (RFC 5545).
// Ohne Escaping zerlegt z. B. "9,99 €" oder ein Abo-Name mit Komma das Feld.
function icsEsc(str) {
  return String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}
// Zeilen über 75 Oktette müssen umgebrochen werden – Fortsetzung beginnt mit einem Leerzeichen.
function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  for (const ch of line) {                       // pro Zeichen, damit Emojis heil bleiben
    const limit = out.length === 0 ? 75 : 74;    // Folgezeilen tragen ein führendes Leerzeichen
    if (enc.encode(cur + ch).length > limit) { out.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

$("ics-btn").addEventListener("click", () => {
  const act = activeSubs();
  if (!act.length) { showToast("Keine aktiven Abos"); return; }
  const lead = profile?.lead_days ?? 3;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Saray OS//DE", "CALSCALE:GREGORIAN"
  ];
  act.forEach((s) => {
    const dt = s.next_payment.replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:sarayos-${s.id}@sarayos`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dt}`,
      `RRULE:FREQ=MONTHLY;INTERVAL=${s.cycle_months}`,
      `SUMMARY:${icsEsc(`${customIcon(s) || "💳"} ${s.name} – ${fmt(bruttoPreis(s))} fällig`)}`,
      "BEGIN:VALARM",
      `TRIGGER:-P${lead}D`,
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsEsc(`${s.name} wird ${lead === 1 ? "morgen" : `in ${lead} Tagen`} abgebucht`)}`,
      "END:VALARM",
      "END:VEVENT"
    );
  });
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.map(icsFold).join("\r\n")], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sarayos-zahltermine.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast("Kalender-Datei erstellt");
});

/* ================= BENACHRICHTIGUNGEN ================= */

/* ---- Echtes Web Push: kommt auch an, wenn die App zu ist ---- */
function b64UrlToBytes(s) {
  const b64 = (s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
async function pushFn(action) {
  const { data, error } = await db.functions.invoke("push", { body: { action } });
  if (error) throw error;
  if (data && data.error) throw new Error(data.error);
  return data;
}
function pushMoeglich() {
  return "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
}

// Meldet dieses Geraet beim Push-Dienst an und hinterlegt das Abo in Supabase.
// Laeuft bei jedem App-Start, weil iOS Anmeldungen still verfallen laesst.
async function registerPush() {
  if (!pushMoeglich() || Notification.permission !== "granted" || !user) return false;
  const reg = await navigator.serviceWorker.ready;

  const anmelden = async () => {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await pushFn("publicKey");
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64UrlToBytes(publicKey)
      });
    }
    return sub;
  };

  let sub = await anmelden();
  let j = sub.toJSON();
  let { error } = await db.from("push_subscriptions").upsert({
    user_id: user.id,
    endpoint: j.endpoint,
    p256dh: j.keys.p256dh,
    auth: j.keys.auth,
    user_agent: navigator.userAgent.slice(0, 300),
    last_seen_at: new Date().toISOString()
  }, { onConflict: "endpoint" });

  // Gehoert der Endpunkt noch einem frueheren Nutzer dieses Geraets, blockt RLS.
  // Dann alte Anmeldung wegwerfen und mit frischem Endpunkt neu anmelden.
  if (error) {
    await sub.unsubscribe().catch(() => {});
    sub = await anmelden();
    j = sub.toJSON();
    ({ error } = await db.from("push_subscriptions").upsert({
      user_id: user.id,
      endpoint: j.endpoint,
      p256dh: j.keys.p256dh,
      auth: j.keys.auth,
      user_agent: navigator.userAgent.slice(0, 300),
      last_seen_at: new Date().toISOString()
    }, { onConflict: "endpoint" }));
    if (error) throw error;
  }
  return true;
}

async function unregisterPush() {
  if (!pushMoeglich()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await db.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  } catch (e) { console.warn(e); }
}

async function requestPush() {
  if (!("Notification" in window)) {
    showToast("Dieses Gerät unterstützt keine Mitteilungen");
    return;
  }
  if (!pushMoeglich()) {
    showToast("Am iPhone zuerst über Teilen → „Zum Home-Bildschirm“ öffnen");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { showToast("Berechtigung abgelehnt"); return; }
  try {
    await registerPush();
    showToast("Mitteilungen aktiv – auch bei geschlossener App");
  } catch (e) {
    console.warn(e);
    showToast("Anmeldung fehlgeschlagen: " + (e.message || e));
  }
}
$("notif-btn").addEventListener("click", requestPush);

// To-Dos im Erinnerungsfenster: fällig innerhalb der Vorlaufzeit – Überfälliges
// bleibt drin, bis es abgehakt ist (anders als Abos, die das rote Panel klärt).
function dueTodos() {
  if (!profile?.reminders_enabled) return [];
  const grenze = new Date(todayMidnight());
  grenze.setDate(grenze.getDate() + (profile.lead_days ?? 3));
  return todos.filter((t) => !t.completed && t.due_date && new Date(t.due_date + "T00:00:00") <= grenze);
}

// Projekt-Deadlines im Erinnerungsfenster – bis der Status auf fertig springt
function dueProjects() {
  if (!profile?.reminders_enabled) return [];
  const grenze = new Date(todayMidnight());
  grenze.setDate(grenze.getDate() + (profile.lead_days ?? 3));
  return projects.filter((p) => p.status !== "fertig" && p.due_date && new Date(p.due_date + "T00:00:00") <= grenze);
}

async function maybeNotifyDue(force) {
  const abos = dueSubs();
  const aufgaben = dueTodos();
  const deadlines = dueProjects();
  if (!abos.length && !aufgaben.length && !deadlines.length) { if (force) showToast("Nichts fällig"); return; }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  // pro Tag nur einmal benachrichtigen – localStorage, sonst gilt das nur pro Browser-Sitzung
  const key = "sarayos-notified-" + todayMidnight().toISOString().slice(0, 10);
  try {
    if (!force && localStorage.getItem(key) === "1") return;
    localStorage.setItem(key, "1");
  } catch (_) { /* Privatmodus o. Ä. – dann eben ohne Merker */ }
  const teile = [];
  if (abos.length) teile.push(abos.length === 1 ? "1 Zahlung" : `${abos.length} Zahlungen`);
  if (aufgaben.length) teile.push(aufgaben.length === 1 ? "1 To-Do" : `${aufgaben.length} To-Dos`);
  if (deadlines.length) teile.push(deadlines.length === 1 ? "1 Deadline" : `${deadlines.length} Deadlines`);
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(`Saray OS – ${teile.join(" · ")}`, {
      body: [
        ...abos.map((s) => `${customIcon(s) || "💳"} ${s.name}: ${fmt(bruttoPreis(s))} am ${fmtDate(new Date(s.next_payment + "T00:00:00"))}`),
        ...aufgaben.map((t) => `☐ ${t.title} (${dateBadge(t.due_date)[1]})`),
        ...deadlines.map((p) => `📁 ${p.name} (${dateBadge(p.due_date)[1]})`)
      ].join("\n"),
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png"
    });
  } catch (e) { console.warn(e); }
}

/* ================= SERVICE WORKER ================= */
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

/* ================= START ================= */
initAuth();
