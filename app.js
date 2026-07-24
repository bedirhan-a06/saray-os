/* ================= AboSaray – App-Logik ================= */
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
let authMode = "login"; // 'login' | 'register'
let activeCat = "Alle";
let activeTab = "home";
let dismissedSavings = false;

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
function ownShareMonthly(s) { return s.price / s.cycle_months / (s.shared_with_count || 1); }
function cycleText(m) { return m === 1 ? "/ Monat" : m === 12 ? "/ Jahr" : `/ ${m} Monate`; }
function esc(str) { const d = document.createElement("div"); d.textContent = str ?? ""; return d.innerHTML; }
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
      user = null; profile = null; subs = [];
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
        $("auth-error").textContent = "Diese E-Mail ist bereits registriert. Melde dich an – oder setze dein Passwort zurück.";
      }
      else $("auth-error").textContent = "Fast geschafft! Bitte bestätige deine E-Mail über den Link in deinem Postfach und melde dich dann an.";
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

$("logout-btn").addEventListener("click", async () => { await db.auth.signOut(); });

$("change-email-btn").addEventListener("click", async () => {
  const email = prompt("Neue E-Mail-Adresse:");
  if (!email) return;
  const { error } = await db.auth.updateUser({ email });
  showToast(error ? "Fehler: " + error.message : "Bestätigungs-Mail verschickt");
});
$("change-pw-btn").addEventListener("click", async () => {
  const pw = prompt("Neues Passwort (mind. 6 Zeichen):");
  if (!pw) return;
  const { error } = await db.auth.updateUser({ password: pw });
  showToast(error ? "Fehler: " + error.message : "Passwort geändert");
});

/* ================= DATEN ================= */
async function enterApp() {
  $("auth-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("today-label").textContent = "Stand: " + fmtDate(todayMidnight());
  $("acct-email").textContent = user.email;
  await loadProfile();
  await loadSubs();
  bindSettingsUI();
  renderAll();
  maybeNotifyDue();
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
    shared_with_count: Number(s.shared_with_count) || 1
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
  renderSummary();
  renderBudget();
  renderOverdue();
  renderSavingsHint();
  renderDueBanner();
  renderCatFilter();
  renderCards();
  renderArchive();
  if (activeTab === "stats") renderStats();
}

function renderSummary() {
  const act = activeSubs();
  const monthly = act.reduce((sum, s) => sum + ownShareMonthly(s), 0);
  $("monthly-total").textContent = fmt(monthly);
  $("yearly-total").textContent = fmt(monthly * 12);
  $("sub-count").textContent = act.length;
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

function renderSavingsHint() {
  const banner = $("savings-banner");
  if (dismissedSavings) { banner.classList.add("hidden"); return; }
  const cutoff = Date.now() - 180 * 864e5;
  const stale = activeSubs().filter((s) => new Date(s.updated_at).getTime() < cutoff);
  if (!stale.length) { banner.classList.add("hidden"); return; }
  banner.classList.remove("hidden");
  banner.innerHTML = `💡 <span>Sparpotential? <strong>${esc(stale.map((s) => s.name).join(", "))}</strong> hast du lange nicht angefasst – nutzt du das noch?</span><button id="savings-close">✕</button>`;
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
    `<div class="ov-head">⏰ ${list.length === 1 ? "Ein Zahltermin ist durch" : list.length + " Zahltermine sind durch"}</div>` +
    list.map((s) => `
      <div class="ov-row" data-id="${s.id}">
        <div class="ov-info">
          <div class="ov-name">${esc(s.icon || "📦")} ${esc(s.name)}</div>
          <div class="ov-sub">${fmt(s.price)} · war am ${fmtDate(new Date(s.next_payment + "T00:00:00"))}</div>
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

function renderDueBanner() {
  const banner = $("due-banner");
  const due = dueSubs();
  if (!due.length) { banner.classList.add("hidden"); return; }
  banner.classList.remove("hidden");
  banner.innerHTML = `🔔 <span>Bald fällig: <strong>${esc(due.map((s) => `${s.name} (${fmtDate(new Date(s.next_payment + "T00:00:00"))})`).join(", "))}</strong></span>`;
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
  const today = todayMidnight();
  const next = new Date(s.next_payment + "T00:00:00");
  const diff = Math.round((next - today) / 864e5);
  const badge = diff < 0 ? ["soon", "überfällig"]
    : diff === 0 ? ["soon", "heute"]
    : diff === 1 ? ["soon", "morgen"]
    : diff <= 7 ? ["soon", `in ${diff} Tagen`]
    : diff <= 21 ? ["mid", `in ${diff} Tagen`]
    : ["far", `in ${diff} Tagen`];
  const catColor = CATEGORIES[s.category] || CATEGORIES.Sonstige;
  // gespeichert wird die Gesamtzahl inkl. Nutzer – angezeigt werden nur die anderen
  const others = (s.shared_with_count || 1) - 1;
  const metaParts = [`${fmt(s.price)} ${cycleText(s.cycle_months)}`];
  if (s.note) metaParts.push(s.note);
  return `
  <div class="card ${archivedView ? "archived" : ""}" data-id="${s.id}">
    <div class="card-top">
      <div class="icon">${esc(s.icon || "📦")}</div>
      <div class="info">
        <div class="name">${esc(s.name)}</div>
        <div class="meta">${esc(metaParts.join(" · "))}</div>
        <span class="cat-tag" style="background:${catColor}22;color:${catColor};">${esc(s.category)}</span>
      </div>
      <div class="right">
        <div class="price">${fmt(ownShareMonthly(s))}/Monat</div>
        <div class="next ${badge[0]}">${fmtDate(next)} · ${badge[1]}</div>
      </div>
    </div>
    ${others > 0 ? `<div class="share-note">geteilt mit ${others} weiteren ${others === 1 ? "Person" : "Personen"} · gesamt ${fmt(s.price / s.cycle_months)}/M</div>` : ""}
    <div class="card-actions">
      ${archivedView
        ? `<button class="unarchive">↩︎ Reaktivieren</button><button class="del">✕ Endgültig löschen</button>`
        : `<button class="edit">✎ Bearbeiten</button><button class="archive">🗄 Archivieren</button><button class="del">✕ Löschen</button>`}
    </div>
  </div>`;
}

function renderCards() {
  const container = $("cards-container");
  let list = sortSubs(activeSubs());
  if (activeCat !== "Alle") list = list.filter((s) => s.category === activeCat);
  container.innerHTML = list.length
    ? list.map((s) => cardHTML(s, false)).join("")
    : `<div class="empty">Noch keine Abos${activeCat !== "Alle" ? " in dieser Kategorie" : ""}. Tippe unten rechts auf „+“.</div>`;
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
  container.innerHTML = list.length
    ? list.map((s) => cardHTML(s, true)).join("")
    : `<div class="empty">Keine archivierten Abos.</div>`;
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
      if (bucket) bucket.sum += s.price / (s.shared_with_count || 1);
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
    $("f-cycle").value = "1";
    $("f-category").value = "Sonstige";
    $("f-custom-wrap").classList.add("hidden");
  }
  $("overlay").classList.add("open");
  setTimeout(() => $("f-name").focus(), 60);
}
function closeModal() { $("overlay").classList.remove("open"); editingId = null; }

$("f-cycle").addEventListener("change", (e) => $("f-custom-wrap").classList.toggle("hidden", e.target.value !== "custom"));
$("add-btn").addEventListener("click", () => openModal(null));
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
  if (error) { showToast("Fehler"); return; }
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

/* ================= EINSTELLUNGEN ================= */
function bindSettingsUI() {
  $("set-reminders").checked = !!profile.reminders_enabled;
  $("set-leaddays").value = String(profile.lead_days ?? 3);
  $("set-sort").value = profile.sort_by || "next_payment";
  $("set-currency").value = profile.currency || "EUR";
  $("set-budget").value = profile.monthly_budget ?? "";

  $("set-reminders").onchange = (e) => { saveProfile({ reminders_enabled: e.target.checked }); renderDueBanner(); };
  $("set-leaddays").onchange = (e) => { saveProfile({ lead_days: parseInt(e.target.value, 10) }); renderDueBanner(); };
  $("set-sort").onchange = (e) => { saveProfile({ sort_by: e.target.value }); renderCards(); };
  $("set-currency").onchange = (e) => { saveProfile({ currency: e.target.value }); renderAll(); };
  $("set-budget").onchange = (e) => {
    const v = e.target.value === "" ? null : Math.max(0, parseFloat(e.target.value));
    saveProfile({ monthly_budget: v });
    renderBudget();
  };
  $("set-push").onclick = requestPush;
}

/* ================= TABS ================= */
document.querySelectorAll(".tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b === btn));
    ["home", "stats", "archive", "settings"].forEach((t) => $("tab-" + t).classList.toggle("hidden", t !== activeTab));
    $("add-btn").classList.toggle("hidden", activeTab !== "home");
    if (activeTab === "stats") renderStats();
  });
});

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
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AboSaray//DE", "CALSCALE:GREGORIAN"
  ];
  act.forEach((s) => {
    const dt = s.next_payment.replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:abosaray-${s.id}@abosaray`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dt}`,
      `RRULE:FREQ=MONTHLY;INTERVAL=${s.cycle_months}`,
      `SUMMARY:${icsEsc(`${s.icon || "💳"} ${s.name} – ${fmt(s.price)} fällig`)}`,
      "BEGIN:VALARM",
      `TRIGGER:-P${lead}D`,
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsEsc(`${s.name} wird in ${lead} Tagen abgebucht`)}`,
      "END:VALARM",
      "END:VEVENT"
    );
  });
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.map(icsFold).join("\r\n")], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "abosaray-zahltermine.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast("Kalender-Datei erstellt");
});

/* ================= BENACHRICHTIGUNGEN ================= */
async function requestPush() {
  if (!("Notification" in window)) { showToast("Nicht unterstützt auf diesem Gerät"); return; }
  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    showToast("Benachrichtigungen aktiviert");
    maybeNotifyDue(true);
  } else {
    showToast("Berechtigung abgelehnt");
  }
}
$("notif-btn").addEventListener("click", requestPush);

async function maybeNotifyDue(force) {
  const due = dueSubs();
  if (!due.length) { if (force) showToast("Aktuell nichts fällig 🎉"); return; }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  // pro Tag nur einmal benachrichtigen – localStorage, sonst gilt das nur pro Browser-Sitzung
  const key = "abosaray-notified-" + todayMidnight().toISOString().slice(0, 10);
  try {
    if (!force && localStorage.getItem(key) === "1") return;
    localStorage.setItem(key, "1");
  } catch (_) { /* Privatmodus o. Ä. – dann eben ohne Merker */ }
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification("AboSaray – Zahlung steht an", {
      body: due.map((s) => `${s.icon || ""} ${s.name}: ${fmt(s.price)} am ${fmtDate(new Date(s.next_payment + "T00:00:00"))}`).join("\n"),
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
