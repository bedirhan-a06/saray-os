/* ================= Saray OS – App-Logik ================= */
"use strict";

/* ---- Supabase (eigenes Projekt von Bedirhan) ---- */
const SUPABASE_URL = "https://whooaauysrlxkmhalqfm.supabase.co";
const SUPABASE_KEY = "sb_publishable_yg_gPdvQYAxR8qEv0alR8Q_j0x0rfxI";
// Die Sitzung geht durch den Tresor: ohne eingerichtetes Schloss wie bisher in
// den Klartext-Speicher, mit Schloss nur noch verschlüsselt (siehe tresor.js).
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: Tresor.speicher, persistSession: true, autoRefreshToken: true }
});
// Alle Schlüssel, unter denen Supabase seine Sitzung ablegt – beim Einrichten
// des Schlosses ziehen genau die in den Tresor um.
const sitzungsSchluessel = () => Object.keys(localStorage).filter((k) => k.startsWith("sb-"));

/* ---- Konstanten ---- */
// Farbe = Dringlichkeit, und eine Kategorie ist keine: alle Kategorien
// tragen dasselbe Grau. Die Unterscheidung leisten Name und Position.
const CATEGORIES = {
  Streaming: "#8a8a8a",
  Musik: "#8a8a8a",
  Software: "#8a8a8a",
  Gaming: "#8a8a8a",
  Cloud: "#8a8a8a",
  Sonstige: "#8a8a8a"
};
// Donut-Abstufung: der groesste Posten leuchtet, der Rest wird stiller
const STAT_TOENE = ["#c8f04a", "#a3a3a3", "#7a7a7a", "#585858", "#3e3e3e", "#2e2e2e"];
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
// Ein fehlgeschlagenes Laden soll nicht wie ein leeres Konto aussehen – vor
// allem nicht bei Auftragswerten und Rechnungen. Die render*-Funktionen lesen
// diese Flags, um bei leerer Liste zwischen „nichts da" und „Fehler" zu unterscheiden.
let subsFehler = false, todosFehler = false, notesFehler = false, projectsFehler = false, eventsFehler = false;
let activeProjectKind = "Alle";
let authMode = "login"; // 'login' | 'register'
let activeCat = "Alle";
let googleFeed = null;    // Zeile aus google_calendar_feeds oder null
let googleEvents = [];    // Termine aus dem Google-Kalender, fürs Agenda-Fenster
let events = [];          // eigene Termine (Tabelle events)
let uniModule = [];       // Uni-Module mit Klausurterminen
let uniFehler = false;
let editingModulId = null;
let fitnessTage = [];     // Split-Tage
let fitnessUebungen = [];
let fitnessSaetze = [];   // Satz-Log der letzten ~4 Monate
let fitnessFehler = false;
let editingUebungId = null, uebungNeuTagId = null;
let trainingTagId = null; // laufendes Training – reine Sitzungs-Sache
let trainingWdh = {};     // uebungId -> eingestellte Wdh fuer den naechsten Satz
let ebenSatz = null, satzTimer = null;
let editingEventId = null;
let aktiveApp = null;     // null = Home, sonst kalender|aufgaben|projekte|finanzen|notizen|optionen
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
  if (!dateStr) return ["still", "ohne Termin"];
  const today = todayMidnight();
  const d = new Date(dateStr + "T00:00:00");
  const diff = Math.round((d - today) / 864e5);
  // Keine Ampel mehr: Signal nur, wenn es dich JETZT braucht.
  // "in 5 Tagen" ist eine Information, keine Warnstufe.
  return diff < 0 ? ["signal", "überfällig"]
    : diff === 0 ? ["signal", "heute"]
    : diff === 1 ? ["still", "morgen"]
    : ["still", `in ${diff} Tagen`];
}
function cycleText(m) { return m === 1 ? "/ Monat" : m === 12 ? "/ Jahr" : `/ ${m} Monate`; }
function esc(str) { const d = document.createElement("div"); d.textContent = str ?? ""; return d.innerHTML; }

// Icon aus dem Sprite in index.html; nimmt per currentColor die Umgebungsfarbe an
function svgIcon(name, cls) {
  return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

// Leerer Bereich mit dem Zeichen der App darüber – dasselbe Modul-Raster wie
// im Logo und im Übersicht-Tab. Wo nichts ist, steht wenigstens das Zeichen.
function leerHTML(text) {
  return `<div class="empty"><svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-module"/></svg>${text}</div>`;
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
/* ---- Fenster auf und zu ----
   Aufgehen war schon immer weich (fadeIn/slideUp), Zugehen sprang dagegen hart
   auf display:none. Der Bruch fiel bei einem der meistbenutzten Elemente auf,
   also läuft das Schließen jetzt dieselbe Bewegung rückwärts ab. */
const OVERLAY_SCHLIESS_MS = 200;

function oeffneOverlay(id) {
  const el = $(id);
  el.classList.remove("schliesst");   // ein noch laufendes Zugehen abbrechen
  el.classList.add("open");
}

function schliesseOverlay(id) {
  const el = $(id);
  if (!el.classList.contains("open")) return;
  el.classList.add("schliesst");
  const fertig = () => {
    // Wurde in der Zwischenzeit wieder geöffnet, steht die Klasse nicht mehr –
    // dann darf hier nichts weggenommen werden.
    if (el.classList.contains("schliesst")) el.classList.remove("open", "schliesst");
  };
  // Zwei Wege zum selben Ziel: normalerweise meldet sich die Animation selbst.
  // Liegt die App im Hintergrund, läuft sie gar nicht erst – dann greift der
  // Wecker, damit kein Fenster offen stehen bleibt.
  el.addEventListener("animationend", fertig, { once: true });
  setTimeout(fertig, OVERLAY_SCHLIESS_MS + 60);
}

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2300);
}

/* ================= SCHLOSS =================
   Sitzt vor der Anmeldung: liegt ein Tresor vor, kommt zuerst der PIN- bzw.
   Face-ID-Bildschirm. Die eigentliche Ver- und Entschlüsselung steckt in
   tresor.js – hier steht nur, was der Nutzer davon sieht. */

const SPERRZEIT_SCHLUESSEL = "saray.sperrzeit";
let pinEingabe = "";
let pinModus = "entsperren";   // entsperren | alt | neu | wiederholen
let pinErstEingabe = "";
let pinAlt = "";               // beim Ändern: der bestätigte bisherige PIN
let hintergrundSeit = null;

function sperrzeit() {
  const v = parseInt(localStorage.getItem(SPERRZEIT_SCHLUESSEL) ?? "300", 10);
  return Number.isFinite(v) ? v : 300;
}

function zeichnePinPunkte() {
  $("pin-dots").innerHTML = Array.from({ length: Tresor.PIN_LAENGE }, (_, i) =>
    `<span class="pin-dot ${i < pinEingabe.length ? "voll" : ""}"></span>`).join("");
}

function bauePinFeld() {
  const tasten = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "bio", "0", "weg"];
  $("pin-pad").innerHTML = tasten.map((t) => {
    if (t === "bio") return `<button class="pin-key nebentaste" data-k="bio" aria-label="Mit Face ID entsperren">${svgIcon("faceid")}</button>`;
    if (t === "weg") return `<button class="pin-key nebentaste" data-k="weg" aria-label="Löschen">${svgIcon("backspace")}</button>`;
    return `<button class="pin-key" data-k="${t}">${t}</button>`;
  }).join("");
  $("pin-pad").querySelectorAll(".pin-key").forEach((b) =>
    b.addEventListener("click", () => pinTaste(b.dataset.k)));
}

function pinTaste(k) {
  if (k === "weg") { pinEingabe = pinEingabe.slice(0, -1); zeichnePinPunkte(); return; }
  if (k === "bio") { entsperreMitFaceId(); return; }
  if (pinEingabe.length >= Tresor.PIN_LAENGE) return;
  pinEingabe += k;
  zeichnePinPunkte();
  if (pinEingabe.length === Tresor.PIN_LAENGE) setTimeout(pinVollstaendig, 120);
}

function pinFehlerWackeln(text) {
  $("lock-hint").textContent = text;
  const karte = document.querySelector(".lock-card");
  karte.classList.remove("wackelt");
  void karte.offsetWidth;
  karte.classList.add("wackelt");
  pinEingabe = "";
  zeichnePinPunkte();
}

async function pinVollstaendig() {
  const eingabe = pinEingabe;
  pinEingabe = "";
  zeichnePinPunkte();

  // Schritt 1 beim Ändern: der bisherige PIN muss stimmen. Das läuft über
  // denselben Fehlversuchszähler wie das normale Entsperren – also muss hier
  // auch die Sperre behandelt werden, sonst stünde man nach zehn Tippfehlern
  // vor einem Schlossbildschirm, hinter dem nichts mehr liegt.
  if (pinModus === "alt") {
    try {
      await Tresor.entsperreMitPin(eingabe);   // prüft und entsperrt zugleich
    } catch (err) {
      if (err.message === "gesperrt") {
        Tresor.verwerfen();
        $("lock-view").classList.add("hidden");
        $("auth-view").classList.remove("hidden");
        $("auth-error").textContent = "Zu viele Fehlversuche. Melde dich einmal mit E-Mail und Passwort an.";
        return;
      }
      const rest = Tresor.MAX_FEHLVERSUCHE - Tresor.fehlversuche();
      pinFehlerWackeln(rest <= 3 ? `Falscher PIN – noch ${rest} Versuche` : "Falscher PIN");
      return;
    }
    pinAlt = eingabe;
    pinModus = "neu";
    $("lock-title").textContent = "Neuer PIN";
    $("lock-hint").textContent = `${Tresor.PIN_LAENGE} Ziffern`;
    return;
  }

  // Schritt 2: neuer PIN, danach zur Kontrolle noch einmal
  if (pinModus === "neu") {
    pinErstEingabe = eingabe;
    pinModus = "wiederholen";
    $("lock-hint").textContent = "Zur Sicherheit nochmal";
    return;
  }

  if (pinModus === "wiederholen") {
    if (eingabe !== pinErstEingabe) {
      pinModus = "neu";
      pinErstEingabe = "";
      pinFehlerWackeln("Stimmt nicht überein – nochmal von vorn");
      return;
    }
    $("lock-hint").textContent = "Einen Moment …";
    try {
      if (pinAlt) await Tresor.pinAendern(pinAlt, eingabe);
      else await Tresor.einrichten(eingabe, sitzungsSchluessel());
      pinAlt = "";
      schliesseSchloss();
      $("app-view").classList.remove("hidden");
      zeichneSperreEinstellungen();
      showToast(Tresor.hatFaceId() ? "PIN geändert" : "PIN eingerichtet");
    } catch (err) {
      console.error(err);
      pinModus = "neu";
      pinFehlerWackeln("Hat nicht geklappt");
    }
    return;
  }

  // Normalfall: entsperren. Das Zurückgeben der Sitzung steht bewusst NICHT im
  // selben try – sonst würde eine abgelaufene Sitzung als „Falscher PIN" gemeldet.
  $("lock-hint").textContent = "Einen Moment …";
  try {
    await Tresor.entsperreMitPin(eingabe);
  } catch (err) {
    if (err.message === "gesperrt") {
      Tresor.verwerfen();
      $("lock-view").classList.add("hidden");
      $("auth-view").classList.remove("hidden");
      $("auth-error").textContent = "Zu viele Fehlversuche. Melde dich einmal mit E-Mail und Passwort an.";
      return;
    }
    const rest = Tresor.MAX_FEHLVERSUCHE - Tresor.fehlversuche();
    pinFehlerWackeln(rest <= 3 ? `Falscher PIN – noch ${rest} Versuche` : "Falscher PIN");
    return;
  }
  await nachEntsperren();
}

async function entsperreMitFaceId() {
  if (!Tresor.hatFaceId()) { $("lock-hint").textContent = "Face ID ist nicht eingerichtet"; return; }
  $("lock-hint").textContent = "Face ID …";
  try {
    await Tresor.entsperreMitFaceId();
    await nachEntsperren();
  } catch (err) {
    console.warn("Face ID:", err);
    $("lock-hint").textContent = "Face ID hat nicht geklappt – PIN eingeben";
  }
}

// Die entschlüsselte Sitzung an Supabase zurückgeben. Ist der Refresh-Token
// abgelaufen oder zurückgezogen, hilft nur noch die normale Anmeldung.
// Nur wegwerfen, wenn der Server die Sitzung wirklich abgelehnt hat. Ein
// Netzfehler darf das NICHT auslösen: das Chiffrat ist die einzige Kopie der
// Anmeldung – eine Fahrt ohne Empfang würde sie sonst endgültig vernichten.
function serverHatAbgelehnt(err) {
  if (!err) return false;
  if (err.name === "AuthRetryableFetchError") return false;
  if (navigator.onLine === false) return false;
  const st = Number(err.status);
  return st === 400 || st === 401 || st === 403 || st === 422;
}

async function nachEntsperren() {
  const s = Tresor.sitzungsDaten();
  if (!s) { tresorUnbrauchbar(); return; }
  let fehler = null;
  try {
    const { error } = await db.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
    fehler = error;
  } catch (err) { fehler = err; }

  if (!fehler) { schliesseSchloss(); return; }

  if (serverHatAbgelehnt(fehler)) { console.warn("Sitzung abgelehnt:", fehler); tresorUnbrauchbar(); return; }

  // Kein Netz: Tresor bleibt, wie er ist. Sobald wieder Verbindung da ist,
  // geht es von selbst weiter – ohne dass der PIN nochmal gebraucht wird.
  console.warn("Keine Verbindung beim Entsperren:", fehler);
  $("lock-hint").textContent = "Keine Verbindung – es geht weiter, sobald du online bist";
  window.addEventListener("online", () => nachEntsperren(), { once: true });
}

function tresorUnbrauchbar() {
  Tresor.verwerfen();
  $("lock-view").classList.add("hidden");
  $("auth-view").classList.remove("hidden");
  $("auth-error").textContent = "Die gespeicherte Anmeldung gilt nicht mehr. Bitte einmal neu anmelden.";
}

function zeigeSchloss(modus) {
  pinModus = modus || "entsperren";
  pinEingabe = "";
  pinErstEingabe = "";
  $("auth-view").classList.add("hidden");
  $("app-view").classList.add("hidden");
  $("lock-view").classList.remove("hidden");
  const titel = { neu: "PIN festlegen", alt: "Bisheriger PIN", wiederholen: "PIN festlegen" };
  $("lock-title").textContent = titel[pinModus] || "Saray OS";
  $("lock-hint").textContent = pinModus === "neu" ? `${Tresor.PIN_LAENGE} Ziffern` : "PIN eingeben";
  $("lock-abmelden").classList.toggle("hidden", pinModus !== "entsperren");
  bauePinFeld();
  zeichnePinPunkte();
  // Face-ID-Taste nur zeigen, wenn sie auch etwas tut
  const bio = $("pin-pad").querySelector('[data-k="bio"]');
  if (bio) bio.classList.toggle("unsichtbar", pinModus !== "entsperren" || !Tresor.hatFaceId());
}

function schliesseSchloss() {
  $("lock-view").classList.add("hidden");
  pinEingabe = "";
  pinErstEingabe = "";
}

$("lock-abmelden").addEventListener("click", async () => {
  if (!confirm("Schloss entfernen und neu mit E-Mail anmelden?")) return;
  Tresor.verwerfen();
  await db.auth.signOut({ scope: "local" }).catch(() => {});
  location.reload();
});

/* ---- Automatisch sperren ---- */
// Beim Zurückkommen aus dem Hintergrund neu laden: so ist garantiert nichts
// Entschlüsseltes mehr im Speicher, nicht nur unsichtbar.
function jetztSperren() {
  // Erst verdecken, dann neu laden: das Neuladen braucht einen Moment, und
  // solange bliebe die entschlüsselte App sonst sichtbar und bedienbar.
  $("app-view").classList.add("hidden");
  $("lock-view").classList.remove("hidden");
  $("lock-hint").textContent = "PIN eingeben";
  location.reload();
}

document.addEventListener("visibilitychange", () => {
  if (!Tresor.eingerichtet() || !Tresor.entsperrt()) return;
  if (document.hidden) { hintergrundSeit = Date.now(); return; }
  const zuLange = hintergrundSeit && Date.now() - hintergrundSeit >= sperrzeit() * 1000;
  hintergrundSeit = null;
  if (zuLange) jetztSperren();
});

/* ---- Einstellungen zur Sperre ---- */
async function zeichneSperreEinstellungen() {
  const an = Tresor.eingerichtet();
  $("set-pin").textContent = an ? "Entfernen" : "Einrichten";
  $("lock-desc").textContent = an
    ? "Die Anmeldung liegt auf diesem Gerät nur verschlüsselt"
    : "Die Anmeldung wird mit deinem PIN verschlüsselt abgelegt";
  ["row-pin-aendern", "row-faceid", "row-sperrzeit", "row-jetzt-sperren"]
    .forEach((id) => $(id).classList.toggle("hidden", !an));
  if (!an) return;

  const hat = Tresor.hatFaceId();
  $("set-faceid").textContent = hat ? "Entfernen" : "Aktivieren";
  // Ohne Plattform-Authentifikator gibt es hier schlicht nichts zu holen
  const moeglich = await Tresor.faceIdMoeglich();
  $("set-faceid").disabled = !moeglich && !hat;
  $("faceid-desc").textContent = hat
    ? "Entsperren ohne PIN-Eingabe"
    : moeglich ? "Entsperren ohne PIN-Eingabe" : "Auf diesem Gerät nicht verfügbar";
}

async function faceIdUmschalten() {
  if (Tresor.hatFaceId()) {
    Tresor.faceIdEntfernen();
    zeichneSperreEinstellungen();
    showToast("Face ID entfernt");
    return;
  }
  const btn = $("set-faceid");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await Tresor.faceIdEinrichten(user?.email, profile?.display_name);
    showToast("Face ID aktiv");
  } catch (err) {
    console.warn("Face ID:", err);
    showToast(err.message === "kein-prf"
      ? "Dieses Gerät kann Face ID nicht zum Entschlüsseln nutzen"
      : "Face ID wurde abgebrochen");
  } finally {
    btn.disabled = false;
    zeichneSperreEinstellungen();
  }
}

/* ================= AUTH ================= */
async function initAuth() {
  // Zuerst horchen, dann erst verzweigen: nach dem Entsperren gibt setSession()
  // die Sitzung zurück, und genau dieser Zuhörer startet dann die App.
  db.auth.onAuthStateChange(async (event, session2) => {
    if (event === "SIGNED_IN" && session2 && !user) {
      user = session2.user;
      await enterApp();
    }
    if (event === "SIGNED_OUT") {
      user = null; profile = null; subs = []; todos = []; notes = []; projects = []; events = [];
      fitnessTage = []; fitnessUebungen = []; fitnessSaetze = []; trainingTagId = null; uniModule = [];
      googleFeed = null; googleEvents = [];
      assistentVerlauf = [];   // das Gespraech gehoert zur Sitzung, nicht zum Geraet
      localStorage.removeItem(GCAL_CACHE_SCHLUESSEL);
      $("app-view").classList.add("hidden");
      $("auth-view").classList.remove("hidden");
    }
  });

  // Liegt ein Tresor vor, kommt niemand an der Sperre vorbei: die Sitzung ist
  // bis zum Entsperren nicht einmal lesbar, Supabase bekommt hier nichts.
  if (Tresor.eingerichtet()) { zeigeSchloss("entsperren"); return; }

  const { data: { session } } = await db.auth.getSession();
  if (session) { user = session.user; await enterApp(); }
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
  // Der Tresor hielte sonst eine widerrufene Sitzung fest und würde beim
  // nächsten Start nach einem PIN fragen, hinter dem nichts Gültiges liegt.
  Tresor.verwerfen();
  zeichneSperreEinstellungen();
});

/* ---- Passwort ändern ---- */
function openPwDialog() {
  $("pw-new").value = "";
  $("pw-again").value = "";
  $("pw-error").textContent = "";
  oeffneOverlay("pw-overlay");
  setTimeout(() => $("pw-new").focus(), 60);
}
function closePwDialog() { schliesseOverlay("pw-overlay"); }

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
  oeffneOverlay("mail-overlay");
  setTimeout(() => $("mail-new").focus(), 60);
}
function closeMailDialog() { schliesseOverlay("mail-overlay"); }

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
  zeigeLadeGeruest(true);
  // Die sechs Abrufe hängen nicht voneinander ab – nacheinander summierte sich
  // ihre Wartezeit bei jedem App-Start. Nur loadGoogleEvents() braucht den Feed
  // und läuft deshalb erst danach.
  await Promise.all([loadProfile(), loadSubs(), loadTodos(), loadNotes(), loadProjects(), loadEvents(), loadFitness(), loadUni(), loadGoogleFeed()]);
  await loadGoogleEvents();
  zeigeLadeGeruest(false);
  bindSettingsUI();
  renderAll();
  kachelnEinzug();   // die Kacheln bauen sich einmal gestaffelt auf
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

// numeric/int kommen als String aus PostgREST – einmal beim Eintreffen sauber machen
function normalisiereAbo(s) {
  return {
    ...s,
    price: Number(s.price),
    cycle_months: Number(s.cycle_months),
    shared_with_count: Number(s.shared_with_count) || 1,
    vat_percent: Number(s.vat_percent) || 0
  };
}

/* ---- Lokal nachziehen statt neu laden ----
   Nach dem Speichern die eine geänderte Zeile lokal ersetzen, statt die ganze
   Tabelle erneut zu holen. Vorbild ist toggleTodo(), das sich dadurch spürbar
   sofort anfühlt – der Rest der App wartete bisher unnötig auf einen zweiten
   Serveraufruf, dessen Antwort schon vorlag. */
function ersetzeInListe(liste, zeile) {
  const i = liste.findIndex((x) => x.id === zeile.id);
  if (i === -1) liste.unshift(zeile); else liste[i] = zeile;
}
function entferneAusListe(liste, id) {
  const i = liste.findIndex((x) => x.id === id);
  if (i !== -1) liste.splice(i, 1);
}

async function loadSubs() {
  const { data, error } = await db.from("subscriptions").select("*").order("next_payment");
  // Bestehende Daten stehen lassen: ein Nachlade-Fehler soll nicht die Liste
  // leeren, die eben noch da war.
  if (error) { subsFehler = true; console.error(error); return; }
  subsFehler = false;
  subs = (data || []).map(normalisiereAbo);
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
  if (error) { todosFehler = true; console.error(error); return; }
  todosFehler = false;
  todos = data || [];
}

async function loadNotes() {
  const { data, error } = await db.from("notes").select("*").order("created_at", { ascending: false });
  if (error) { notesFehler = true; console.error(error); return; }
  notesFehler = false;
  notes = data || [];
}

async function loadProjects() {
  const { data, error } = await db.from("projects").select("*").order("created_at", { ascending: false });
  if (error) { projectsFehler = true; console.error(error); return; }
  projectsFehler = false;
  projects = data || [];
}

async function loadEvents() {
  const { data, error } = await db.from("events").select("*").order("date");
  if (error) { eventsFehler = true; console.error(error); return; }
  eventsFehler = false;
  // Postgres liefert time als "14:00:00" – die App rechnet ueberall mit HH:MM
  events = (data || []).map((ev) => ({ ...ev, time: ev.time ? String(ev.time).slice(0, 5) : null }));
}

async function loadUni() {
  const { data, error } = await db.from("uni_module").select("*").order("klausur_am");
  if (error) { uniFehler = true; console.error(error); return; }
  uniFehler = false;
  uniModule = (data || []).map((m) => ({ ...m, klausur_um: m.klausur_um ? String(m.klausur_um).slice(0, 5) : null }));
}

async function loadFitness() {
  // Vier Monate Satz-Historie reichen der App; die Steigerungslogik braucht
  // ohnehin nur den Zustand an der Uebung selbst.
  const seit = toDateStr(new Date(Date.now() - 120 * 864e5));
  const [t, u, sz] = await Promise.all([
    db.from("fitness_tage").select("*").order("position"),
    db.from("fitness_uebungen").select("*").order("position"),
    db.from("fitness_saetze").select("*").gte("datum", seit).order("datum"),
  ]);
  if (t.error || u.error || sz.error) {
    fitnessFehler = true;
    console.error(t.error || u.error || sz.error);
    return;
  }
  fitnessFehler = false;
  fitnessTage = t.data || [];
  fitnessUebungen = (u.data || []).map((x) => ({
    ...x,
    gewicht: x.gewicht == null ? null : Number(x.gewicht),
    schritt: Number(x.schritt) || 2.5,
  }));
  fitnessSaetze = (sz.data || []).map((x) => ({ ...x, gewicht: x.gewicht == null ? null : Number(x.gewicht) }));
}

/* ---- Ladezustand und Fehlerzustand ----
   Beim Start stand die App leer da, bis alle Abrufe durch waren – ohne dass
   irgendwas erklärte, warum. Und ein fehlgeschlagener Abruf sah danach genauso
   aus wie ein leeres Konto. Beides bekommt hier eine eigene Darstellung. */

// Graue Platzhalter-Karten, solange die Daten unterwegs sind
function zeigeLadeGeruest(an) {
  const geruest = `<div class="skeleton-list">${
    Array.from({ length: 3 }, () => `<div class="skeleton-card"></div>`).join("")}</div>`;
  ["agenda-container", "cards-container", "todos-container", "notes-container", "projects-container"]
    .forEach((id) => { const el = $(id); if (el && an) el.innerHTML = geruest; });
  $("app-view").classList.toggle("laedt", an);
}

// Statt des normalen Leertexts, wenn der Abruf gescheitert ist
function fehlerHTML(bereich) {
  return `<div class="empty fehler">
    <svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-module"/></svg>
    Konnte nicht geladen werden.
    <button class="btn" data-neuladen="${bereich}">Erneut versuchen</button>
  </div>`;
}

// Einen Bereich neu abrufen, ohne die ganze App neu zu starten
async function ladeBereichNeu(bereich) {
  const lader = { abos: loadSubs, todos: loadTodos, notizen: loadNotes, projekte: loadProjects, termine: loadEvents, fitness: loadFitness, uni: loadUni }[bereich];
  if (!lader) return;
  await lader();
  renderAll();
}

// Ein Fänger für alle Wiederholen-Knöpfe – sie entstehen erst beim Rendern
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-neuladen]");
  if (btn) ladeBereichNeu(btn.dataset.neuladen);
});

/* ---- Google-Kalender ----
   Die private iCal-Adresse liegt RLS-geschützt in google_calendar_feeds.
   Abgerufen wird über die Edge Function (der Browser darf calendar.google.com
   nicht direkt fragen – kein CORS). Kurzer Cache, damit schnelles Schließen
   und Wiederöffnen der App nicht jedes Mal einen Google-Abruf auslöst. */
const GCAL_CACHE_SCHLUESSEL = "saray.google-cal.cache";
const GCAL_CACHE_MINUTEN = 15;

async function loadGoogleFeed() {
  const { data } = await db.from("google_calendar_feeds").select("*").eq("user_id", user.id).maybeSingle();
  googleFeed = data || null;
}

async function loadGoogleEvents() {
  googleEvents = [];
  if (!googleFeed) return;   // nichts verknüpft – kein Aufruf
  try {
    const cache = JSON.parse(localStorage.getItem(GCAL_CACHE_SCHLUESSEL) || "null");
    if (cache && cache.userId === user.id && Date.now() - cache.at < GCAL_CACHE_MINUTEN * 60000) {
      googleEvents = cache.events || [];
      return;
    }
  } catch (_) { /* kaputter Cache-Eintrag – einfach frisch laden */ }
  // Bewusst leise bei Fehlern: ein kaputter Link soll nicht bei jedem
  // App-Start einen Toast auslösen – der Test-Knopf in den Einstellungen meldet es.
  const { data, error } = await db.functions.invoke("google-calendar", { body: { action: "sync" } });
  if (error || !data || data.error) { console.warn("Google-Kalender:", error || data?.error); return; }
  googleEvents = data.events || [];
  try {
    localStorage.setItem(GCAL_CACHE_SCHLUESSEL, JSON.stringify({ userId: user.id, at: Date.now(), events: googleEvents }));
  } catch (_) { /* Privatmodus o. Ä. – dann eben ohne Cache */ }
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
  renderHome();
  renderSummary();
  renderEinnahmen();
  renderBudget();
  renderOverdue();
  renderSavingsHint();
  renderAgendaAnsicht();
  renderCatFilter();
  renderCards();
  renderArchive();
  renderTodos();
  renderNoteTagFilter();
  renderNotes();
  renderProjectKindFilter();
  renderProjects();
  renderFitness();
  renderUni();
  // Donut und Balken sind die teuersten Zeichnungen – nur wenn Finanzen offen ist
  if (aktiveApp === "finanzen") renderStats();
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
  zahlRollen($("monthly-total"), fmt(monthly));
  zahlRollen($("yearly-total"), fmt(monthly * 12));
}

// Ab hier gilt eine Rechnung als überfällig – dieselbe Frist wie im täglichen
// Rundlauf (RECHNUNG_FRIST_TAGE in functions/push).
const RECHNUNG_MAHNUNG_TAGE = 14;

/* ================= HOME: LEBENDE KACHELN =================
   Der Home-Bildschirm ist der Statusbericht: jede Kachel sagt ihren Stand,
   bevor man tippt. Signalfarbe gibt es nur, wo etwas Bedo heute braucht –
   dieselbe Regel wie im ganzen Design. */

// Eine Zahl, die sich ändert, meldet sich kurz, statt stumm zu springen
function zahlRollen(el, text) {
  if (!el || el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("rollt");
  void el.offsetWidth;
  el.classList.add("rollt");
}

function heuteZeilen() {
  const heuteStr = toDateStr(todayMidnight());
  const zeilen = [];
  const ueberfaellig = todos.filter((t) => !t.completed && t.due_date && t.due_date < heuteStr);
  ueberfaellig.slice(0, 2).forEach((t) =>
    zeilen.push(`<span class="sig">▪ ${esc(t.title)} — überfällig</span>`));
  if (ueberfaellig.length > 2)
    zeilen.push(`<span class="sig">▪ ${ueberfaellig.length - 2} weitere überfällig</span>`);
  const termineHeute = [
    ...events.filter((ev) => ev.date === heuteStr),
    ...googleEvents.filter((g) => g.date === heuteStr),
  ];
  termineHeute.slice(0, 3).forEach((t) =>
    zeilen.push(`▪ ${esc(t.title)}${t.time ? ` · ${esc(t.time)}` : ""}`));
  const klausurBald = naechsteKlausur();
  if (klausurBald && klausurBald.tage <= 7)
    zeilen.push(`<span class="sig">▪ Klausur ${esc(klausurBald.m.name)} — ${klausurBald.tage === 0 ? "HEUTE" : klausurBald.tage === 1 ? "morgen" : `in ${klausurBald.tage} Tagen`}</span>`);
  if (fitnessDran()) zeilen.push(`<span class="sig">▪ Gym: ${esc(dranTag().name)} dran</span>`);
  const faellig = overdueSubs();
  if (faellig.length)
    zeilen.push(`<span class="sig">▪ ${faellig.length === 1 ? "Ein Abo wartet auf Bezahlt" : faellig.length + " Abos warten auf Bezahlt"}</span>`);
  const z = einnahmenZahlen();
  if (z.offen > 0 && z.aeltesteRechnung >= RECHNUNG_MAHNUNG_TAGE)
    zeilen.push(`<span class="sig">▪ Rechnung ${esc(fmt(z.offen))} — seit ${z.aeltesteRechnung} Tagen offen</span>`);
  todos.filter((t) => !t.completed && t.due_date === heuteStr).slice(0, 2)
    .forEach((t) => zeilen.push(`▪ ${esc(t.title)} — heute`));
  return zeilen.slice(0, 5);
}

function renderHome() {
  const heuteInhalt = $("heute-inhalt");
  if (!heuteInhalt) return;
  $("heute-titel").textContent = "Heute · " +
    new Date().toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" });
  const zeilen = heuteZeilen();
  heuteInhalt.innerHTML = zeilen.length
    ? zeilen.join("<br>")
    : `<span class="heute-leer">Nichts drängt heute.</span>`;

  const heuteStr = toDateStr(todayMidnight());
  const kommende = [
    ...events.filter((ev) => ev.date >= heuteStr).map((ev) => ({ titel: ev.title, datum: ev.date, zeit: ev.time })),
    ...googleEvents.filter((g) => g.date >= heuteStr).map((g) => ({ titel: g.title, datum: g.date, zeit: g.time })),
  ].sort((a, b) => a.datum < b.datum ? -1 : a.datum > b.datum ? 1
    : String(a.zeit || "99").localeCompare(String(b.zeit || "99")));
  $("stat-kalender").innerHTML = kommende.length
    ? `${esc(kurzDatum(new Date(kommende[0].datum + "T00:00:00")))}${kommende[0].zeit ? " " + esc(kommende[0].zeit) : ""} · ${esc(kommende[0].titel)}`
    : "Keine Termine";

  const offen = todos.filter((t) => !t.completed);
  const zuSpaet = offen.filter((t) => t.due_date && t.due_date < heuteStr).length;
  $("stat-aufgaben").innerHTML = offen.length
    ? `${zuSpaet ? `<span class="sig">${zuSpaet} überfällig</span> · ` : ""}${offen.length} offen`
    : "Alles erledigt";

  const inArbeit = projects.filter((pr) => pr.status === "in Arbeit").length;
  const aktiv = projects.filter((pr) => pr.status !== "fertig").length;
  $("stat-projekte").textContent = aktiv ? `${inArbeit} in Arbeit · ${aktiv} aktiv` : "Keine aktiven";

  const monatlich = activeSubs().reduce((sum, s2) => sum + ownShareMonthly(s2), 0);
  const z = einnahmenZahlen();
  const teile = [`Abos ${fmt(monatlich)}/M`];
  if (z.offen > 0) teile.push(`<span class="${z.aeltesteRechnung >= RECHNUNG_MAHNUNG_TAGE ? "sig" : ""}">${esc(fmt(z.offen))} offen</span>`);
  $("stat-finanzen").innerHTML = teile.join(" · ");

  const kl = naechsteKlausur();
  const offeneErgebnisse = uniModule.filter((m) => m.status === "laeuft" && m.klausur_am && m.klausur_am < heuteStr).length;
  $("stat-uni").innerHTML = !uniModule.length ? "Module anlegen"
    : kl ? `${kl.tage <= 7 ? `<span class="sig">Klausur ${kl.tage === 0 ? "HEUTE" : kl.tage === 1 ? "morgen" : `in ${kl.tage} T.`}</span>` : `Klausur ${esc(kurzDatum(new Date(kl.m.klausur_am + "T00:00:00")))}`} · ${esc(kl.m.name)}`
    : offeneErgebnisse ? `<span class="sig">${offeneErgebnisse === 1 ? "1 Ergebnis" : offeneErgebnisse + " Ergebnisse"} offen</span>`
    : `${uniModule.filter((m) => m.status === "laeuft").length} Module laufen`;

  const fitKachel = $("k-fitness");
  if (fitKachel) {
    const dran = fitnessTage.length ? dranTag() : null;
    const dranJetzt = fitnessDran();
    fitKachel.classList.toggle("dran", dranJetzt);
    $("stat-fitness").innerHTML = !fitnessTage.length ? "Coach einrichten"
      : heuteTrainiert() ? "✓ heute trainiert"
      : dranJetzt ? `heute dran — ${esc(dran.name)}`
      : `als Nächstes: ${esc(dran.name)}`;
  }

  $("stat-notizen").textContent = notes.length
    ? (notes[0].content.split("\n")[0].slice(0, 34) || `${notes.length} Notizen`)
    : "Noch keine";
}

// Beim Start bauen sich die Kacheln einmal gestaffelt auf, danach ist Ruhe
function kachelnEinzug() {
  const raster = $("kachel-raster");
  if (!raster) return;
  raster.classList.remove("kacheln-rein");
  void raster.offsetWidth;
  raster.classList.add("kacheln-rein");
  setTimeout(() => raster.classList.remove("kacheln-rein"), 900);
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
  const { data, error } = await db.from("subscriptions")
    .update({ next_payment: toDateStr(next), updated_at: new Date().toISOString() })
    .eq("id", id).select().single();
  if (error) { showToast("Fehler beim Speichern"); console.error(error); return; }
  showToast(`${s.name}: nächste Zahlung ${fmtDate(next)}`);
  ersetzeInListe(subs, normalisiereAbo(data));
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
  events.forEach((ev) => {
    const d = new Date(ev.date + "T00:00:00");
    if (d >= heute && d <= grenze) items.push({ art: "termin", datum: d, zeit: ev.time, ev });
  });
  uniModule.forEach((m) => {
    if (m.status !== "laeuft" || !m.klausur_am) return;
    const d = new Date(m.klausur_am + "T00:00:00");
    if (d >= heute && d <= grenze) items.push({ art: "klausur", datum: d, zeit: m.klausur_um, m });
  });
  googleEvents.forEach((g) => {
    const d = new Date(g.date + "T00:00:00");
    // Vergangenes interessiert hier nicht – der Kalender ist kein To-Do
    if (d >= heute && d <= grenze) items.push({ art: "google", datum: d, zeit: g.time, g });
  });
  return items.sort(sortiereAgenda);
}

// Erst Datum, dann Uhrzeit; was keine Uhrzeit hat, steht am Tagesende
function sortiereAgenda(a, b) {
  if (a.datum - b.datum) return a.datum - b.datum;
  const za = a.zeit || "99:99", zb = b.zeit || "99:99";
  return za < zb ? -1 : za > zb ? 1 : 0;
}

function agendaChip(dateStr, datum) {
  const badge = dateBadge(dateStr);
  const text = ["heute", "morgen", "überfällig"].includes(badge[1])
    ? badge[1]
    : `${kurzDatum(datum)} · ${badge[1]}`;
  return `<div class="next ${badge[0]}">${text}</div>`;
}

// Eine Agenda-Zeile. Liste und Monatsansicht teilen sich dieselbe Darstellung
// und dieselben Klick-Ziele – darum als eigene Funktion statt doppelt gebaut.
function agendaRowHTML(it) {
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
  if (it.art === "termin") {
    return `
    <div class="agenda-row" data-art="termin" data-id="${it.ev.id}">
      <div class="icon">${svgIcon("calendar")}</div>
      <div class="agenda-body">
        <div class="agenda-title">${esc(it.ev.title)}</div>
        <div class="agenda-meta">Termin${it.ev.time ? ` · ${esc(it.ev.time)} Uhr` : ""}</div>
      </div>
      ${agendaChip(it.ev.date, it.datum)}
    </div>`;
  }
  if (it.art === "klausur") {
    return `
    <div class="agenda-row" data-art="klausur" data-id="${it.m.id}">
      <div class="icon">${svgIcon("uni")}</div>
      <div class="agenda-body">
        <div class="agenda-title">${esc(it.m.name)}</div>
        <div class="agenda-meta">Klausur${it.m.klausur_um ? ` · ${esc(it.m.klausur_um)} Uhr` : ""}</div>
      </div>
      ${agendaChip(it.m.klausur_am, it.datum)}
    </div>`;
  }
  if (it.art === "google") {
    return `
    <div class="agenda-row" data-art="google" data-id="${esc(it.g.uid)}">
      <div class="icon">${svgIcon("calendar")}</div>
      <div class="agenda-body">
        <div class="agenda-title">${esc(it.g.title)}</div>
        <div class="agenda-meta">Google-Kalender${it.g.time ? ` · ${esc(it.g.time)} Uhr` : ""}</div>
      </div>
      ${agendaChip(it.g.date, it.datum)}
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
}

function bindAgendaRowClicks(box) {
  box.querySelectorAll(".agenda-row").forEach((el) => {
    const id = el.dataset.id;
    if (el.dataset.art === "todo") {
      // Beim To-Do haengen zwei getrennte Ziele dran: Haekchen abhaken,
      // Textbereich oeffnet das Modal. Nicht die ganze Zeile wie sonst.
      el.querySelector(".todo-check").addEventListener("click", (e) => { e.stopPropagation(); toggleTodo(id); });
      el.querySelector(".agenda-body").addEventListener("click", () => openTodoModal(id));
    } else if (el.dataset.art === "projekt") {
      el.addEventListener("click", () => openProjectModal(id));
    } else if (el.dataset.art === "abo") {
      el.addEventListener("click", () => openModal(id));
    } else if (el.dataset.art === "termin") {
      el.addEventListener("click", () => openEventModal(id));
    } else if (el.dataset.art === "klausur") {
      el.addEventListener("click", () => openModulModal(id));
    }
    // art === "google": bewusst kein Klick-Ziel. Der ICS-Export von Google
    // liefert keine brauchbare Sprungadresse zum einzelnen Termin – ein Link
    // auf die generische Kalenderansicht wäre mehr Verwirrung als Nutzen.
  });
}

function renderAgenda() {
  stilleZeichnung();
  const box = $("agenda-container");
  if (!box) return;
  const items = agendaItems();
  if (!items.length) {
    // Die Agenda speist sich aus drei Quellen – ist eine davon nicht angekommen,
    // ist „nichts fällig" schlicht nicht wahr.
    box.innerHTML = (subsFehler || todosFehler || projectsFehler || eventsFehler)
      ? fehlerHTML(subsFehler ? "abos" : todosFehler ? "todos" : projectsFehler ? "projekte" : "termine")
      : leerHTML(`In den nächsten ${AGENDA_TAGE} Tagen ist nichts fällig.`);
    return;
  }
  box.innerHTML = items.map(agendaRowHTML).join("");
  bindAgendaRowClicks(box);
}

/* ---- Monatsansicht ----
   Dieselben vier Quellen wie die Liste, nur als Kalenderblatt. */

// Immer 42 Tage (6 Wochen): fuehrende und nachfolgende Tage der Nachbarmonate
// fuellen das Gitter auf, damit die Wochentag-Spalten nie verrutschen und es
// keine Fallunterscheidung 5-vs-6-Wochen braucht.
function monatsTage(jahr, monat) {
  const erster = new Date(jahr, monat, 1);
  const wochentag = (erster.getDay() + 6) % 7;   // Mo=0 … So=6, nicht JS-Standard So=0
  const start = new Date(jahr, monat, 1 - wochentag);
  return Array.from({ length: 42 }, (_, i) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

// Wie agendaItems(), aber ohne 7-Tage-Grenze und ohne das Ausblenden
// überfälliger Abos: die Liste blendet die aus, weil sie oben im roten Panel
// stehen – ein Kalenderblatt soll den Tag dagegen ehrlich zeigen.
function agendaItemsImZeitraum(von, bis) {
  const items = [];
  const imFenster = (d) => d >= von && d <= bis;
  activeSubs().forEach((s) => {
    const d = new Date(s.next_payment + "T00:00:00");
    if (imFenster(d)) items.push({ art: "abo", datum: d, s });
  });
  todos.forEach((t) => {
    if (t.completed || !t.due_date) return;
    const d = new Date(t.due_date + "T00:00:00");
    if (imFenster(d)) items.push({ art: "todo", datum: d, t });
  });
  projects.forEach((p) => {
    if (p.status === "fertig" || !p.due_date) return;
    const d = new Date(p.due_date + "T00:00:00");
    if (imFenster(d)) items.push({ art: "projekt", datum: d, p });
  });
  events.forEach((ev) => {
    const d = new Date(ev.date + "T00:00:00");
    if (imFenster(d)) items.push({ art: "termin", datum: d, zeit: ev.time, ev });
  });
  uniModule.forEach((m) => {
    if (m.status !== "laeuft" || !m.klausur_am) return;
    const d = new Date(m.klausur_am + "T00:00:00");
    if (imFenster(d)) items.push({ art: "klausur", datum: d, zeit: m.klausur_um, m });
  });
  googleEvents.forEach((g) => {
    const d = new Date(g.date + "T00:00:00");
    if (imFenster(d)) items.push({ art: "google", datum: d, zeit: g.time, g });
  });
  return items.sort(sortiereAgenda);
}

let monatsAnker = null;        // 1. des angezeigten Monats
let monatsAktiverTag = null;   // "YYYY-MM-DD" oder null
let monatsNachTag = {};        // Termine gruppiert, fuer die Detailliste

function monatWechseln(delta) {
  monatsAnker = new Date(monatsAnker.getFullYear(), monatsAnker.getMonth() + delta, 1);
  monatsAktiverTag = null;
  renderMonatsansicht(true);
}

function renderMonatsansicht(mitEinzug) {
  const box = $("monat-container");
  if (!box) return;
  if (!monatsAnker) {
    const h = todayMidnight();
    monatsAnker = new Date(h.getFullYear(), h.getMonth(), 1);
  }
  const jahr = monatsAnker.getFullYear(), monat = monatsAnker.getMonth();
  const tage = monatsTage(jahr, monat);
  const items = agendaItemsImZeitraum(tage[0], tage[41]);
  monatsNachTag = {};
  items.forEach((it) => (monatsNachTag[toDateStr(it.datum)] ||= []).push(it));
  const heuteStr = toDateStr(todayMidnight());

  box.innerHTML = `
    <div class="monat-nav">
      <button id="monat-zurueck" aria-label="Vorheriger Monat">${svgIcon("chevron-left")}</button>
      <span class="monat-titel">${monatsAnker.toLocaleDateString("de-DE", { month: "long", year: "numeric" })}</span>
      <button id="monat-vor" aria-label="Nächster Monat">${svgIcon("chevron-right")}</button>
    </div>
    <div class="monat-wochentage">${["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((w) => `<span>${w}</span>`).join("")}</div>
    <div class="monat-grid${mitEinzug ? " wechsel" : ""}">
      ${tage.map((d) => {
        const ds = toDateStr(d);
        const anzahl = (monatsNachTag[ds] || []).length;
        const punkte = !anzahl ? "" : `<div class="punkt-reihe">${
          anzahl <= 3
            ? Array.from({ length: anzahl }, () => `<span class="punkt"></span>`).join("")
            : `<span class="punkt mehr">+${anzahl}</span>`
        }</div>`;
        return `<button class="monat-tag${d.getMonth() !== monat ? " ausserhalb" : ""}${ds === heuteStr ? " heute" : ""}${ds === monatsAktiverTag ? " aktiv" : ""}" data-datum="${ds}">
          <span>${d.getDate()}</span>${punkte}
        </button>`;
      }).join("")}
    </div>
    <div class="monat-tag-details" id="monat-tag-details"></div>`;

  $("monat-zurueck").addEventListener("click", () => monatWechseln(-1));
  $("monat-vor").addEventListener("click", () => monatWechseln(1));
  box.querySelectorAll(".monat-tag").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Nur Klassen umschalten und die Detailliste erneuern – nicht das ganze
      // Gitter neu zeichnen, sonst spielt der Einzug bei jedem Tipp erneut.
      box.querySelectorAll(".monat-tag.aktiv").forEach((el) => el.classList.remove("aktiv"));
      monatsAktiverTag = monatsAktiverTag === btn.dataset.datum ? null : btn.dataset.datum;
      if (monatsAktiverTag) btn.classList.add("aktiv");
      renderMonatTagDetails();
    });
  });
  renderMonatTagDetails();
}

function renderMonatTagDetails() {
  const el = $("monat-tag-details");
  if (!el) return;
  if (!monatsAktiverTag) { el.innerHTML = ""; return; }
  const items = monatsNachTag[monatsAktiverTag] || [];
  el.innerHTML = items.length ? items.map(agendaRowHTML).join("") : leerHTML("An diesem Tag ist nichts.");
  bindAgendaRowClicks(el);
}

/* ---- Umschalter Liste / Monat ---- */
let agendaAnsicht = "liste";

function renderAgendaAnsicht() {
  const liste = agendaAnsicht === "liste";
  $("agenda-view-toggle").querySelectorAll(".chip")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === agendaAnsicht));
  $("agenda-titel").textContent = liste ? `Nächste ${AGENDA_TAGE} Tage` : "Monat";
  $("agenda-container").classList.toggle("hidden", !liste);
  $("monat-container").classList.toggle("hidden", liste);
  liste ? renderAgenda() : renderMonatsansicht(false);
}

$("agenda-view-toggle").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b || b.dataset.view === agendaAnsicht) return;
  agendaAnsicht = b.dataset.view;
  renderAgendaAnsicht();
});

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
  stilleZeichnung();
  const container = $("cards-container");
  let list = sortSubs(activeSubs());
  if (activeCat !== "Alle") list = list.filter((s) => s.category === activeCat);
  container.innerHTML = list.length
    ? list.map((s) => cardHTML(s, false)).join("")
    : subsFehler
      ? fehlerHTML("abos")
      : leerHTML(`Noch keine Abos${activeCat !== "Alle" ? " in dieser Kategorie" : ""} – tipp unten rechts auf „+“.`);
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
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([cat, val], i) => {
    const frac = val / total;
    const ton = STAT_TOENE[Math.min(i, STAT_TOENE.length - 1)];
    const el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    el.setAttribute("cx", C); el.setAttribute("cy", C); el.setAttribute("r", R);
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", ton);
    el.setAttribute("stroke-width", "20");
    el.setAttribute("stroke-dasharray", `${frac * circ} ${circ}`);
    el.setAttribute("stroke-dashoffset", String(-offset * circ));
    el.setAttribute("transform", `rotate(-90 ${C} ${C})`);
    svg.appendChild(el);
    offset += frac;
    legend.innerHTML += `<div class="li"><span class="dot" style="background:${ton}"></span>${esc(cat)}<span class="amt">${fmt(val)} · ${Math.round(frac * 100)} %</span></div>`;
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
  oeffneOverlay("overlay");
  setTimeout(() => $("f-name").focus(), 60);
}
function closeModal() { schliesseOverlay("overlay"); editingId = null; }

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
$("projekt-add-btn").addEventListener("click", () => openProjectModal(null));
$("abo-add-btn").addEventListener("click", () => openModal(null));
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
        const { data: hist } = await db.from("price_history")
          .insert({ subscription_id: editingId, user_id: user.id, old_price: old.price, new_price: price })
          .select().single();
        // Neueste zuerst – dieselbe Reihenfolge, die loadSubs() vom Server holt
        if (hist) (history[editingId] = history[editingId] || []).unshift(hist);
      }
      const { data, error } = await db.from("subscriptions").update(row).eq("id", editingId).select().single();
      if (error) throw error;
      ersetzeInListe(subs, normalisiereAbo(data));
      showToast("Aktualisiert");
    } else {
      const { data, error } = await db.from("subscriptions").insert({ ...row, user_id: user.id }).select().single();
      if (error) throw error;
      ersetzeInListe(subs, normalisiereAbo(data));
      showToast("Hinzugefügt");
    }
    closeModal();
    renderAll();
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    $("submit-btn").disabled = false;
  }
});

async function setArchived(id, archived) {
  const { data, error } = await db.from("subscriptions")
    .update({ archived, updated_at: new Date().toISOString() }).eq("id", id).select().single();
  if (error) { showToast(archived ? "Fehler beim Archivieren" : "Fehler beim Reaktivieren"); return; }
  showToast(archived ? "Archiviert" : "Reaktiviert");
  ersetzeInListe(subs, normalisiereAbo(data));
  renderAll();
}

async function deleteSub(id) {
  const s = subs.find((x) => x.id === id);
  if (!s) return;
  if (!confirm(`„${s.name}“ wirklich endgültig löschen?${s.archived ? "" : "\n\nTipp: Mit „Archivieren“ bleibt es in der Historie."}`)) return;
  const { error } = await db.from("subscriptions").delete().eq("id", id);
  if (error) { showToast("Fehler beim Löschen"); return; }
  showToast("Gelöscht");
  entferneAusListe(subs, id);
  delete history[id];
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
  // Aufbau in drei Schichten: Wisch-Hinweise liegen fest im Hintergrund,
  // der Koerper bewegt sich beim Wischen darueber, der Sweep fegt beim
  // Erledigen einmal durch – die Farbe verlaesst die Zeile woertlich.
  return `
  <div class="todo-row ${t.completed ? "done" : ""}${t.id === ebenAbgehakt ? " eben-bewegt" : ""}" data-id="${t.id}">
    <span class="wisch-hinweis rechts">✓ erledigt</span>
    <span class="wisch-hinweis links">löschen</span>
    <div class="zeilen-koerper">
      <button class="todo-check ${t.completed ? "checked" : ""}${t.id === ebenAbgehakt ? " just" : ""}" aria-label="Erledigt"></button>
      <div class="todo-body">
        <div class="todo-title">${tagTextHTML(t.title)}</div>
        <div class="todo-meta ${t.completed ? "" : badge[0]}">${metaParts.join(" · ")}</div>
      </div>
    </div>
    ${t.id === ebenAbgehakt && t.completed ? `<span class="zeilen-sweep"></span>` : ""}
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
  stilleZeichnung();
  const container = $("todos-container");
  if (!container) return;
  // Erledigte bleiben nur bis Tagesende sichtbar (Bestätigung fürs Abhaken),
  // damit die Liste nicht mit alten Häkchen vollläuft.
  const heute = toDateStr(todayMidnight());
  const visible = todos.filter((t) => !t.completed || (t.completed_at && toDateStr(new Date(t.completed_at)) === heute));
  const sorted = sortTodos(visible);
  container.innerHTML = sorted.length
    ? sorted.map(todoRowHTML).join("")
    : todosFehler
      ? fehlerHTML("todos")
      : leerHTML("Noch keine To-Dos – trag oben etwas ein.");
  container.querySelectorAll(".todo-row").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector(".todo-check").addEventListener("click", (e) => { e.stopPropagation(); toggleTodo(id); });
    el.querySelector(".todo-body").addEventListener("click", () => openTodoModal(id));
    bindeWisch(el, id);
  });
}

/* ---- Wischgesten: rechts erledigt, links loescht ----
   Der Koerper folgt dem Finger, die Hinweise dahinter werden sichtbar.
   Erst ab 12 px klar horizontaler Bewegung greift die Geste – sonst
   kaempfte sie mit dem normalen Scrollen. Knoepfe bleiben als zweiter Weg. */
function bindeWisch(row, id) {
  const koerper = row.querySelector(".zeilen-koerper");
  if (!koerper) return;
  let sx = 0, sy = 0, dx = 0, greift = false;
  row.addEventListener("touchstart", (e) => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; greift = false;
  }, { passive: true });
  row.addEventListener("touchmove", (e) => {
    const nx = e.touches[0].clientX - sx, ny = e.touches[0].clientY - sy;
    if (!greift && Math.abs(nx) > 12 && Math.abs(nx) > Math.abs(ny) * 1.4) greift = true;
    if (!greift) return;
    dx = nx;
    koerper.style.transform = `translateX(${dx}px)`;
    const rechts = row.querySelector(".wisch-hinweis.rechts");
    const links = row.querySelector(".wisch-hinweis.links");
    if (rechts) rechts.style.opacity = dx > 34 ? "1" : "0";
    if (links) links.style.opacity = dx < -34 ? "1" : "0";
  }, { passive: true });
  row.addEventListener("touchend", () => {
    koerper.style.transition = "transform 0.2s ease";
    koerper.style.transform = "";
    setTimeout(() => { koerper.style.transition = ""; }, 220);
    row.querySelectorAll(".wisch-hinweis").forEach((h) => { h.style.opacity = "0"; });
    if (!greift) return;
    if (dx > 80) toggleTodo(id);
    else if (dx < -80) deleteTodo(id);
  });
}

// Live zeigen, was der Datums-Parser verstanden hat – Vertrauen entsteht,
// wenn man VOR dem Speichern sieht, was passieren wird.
function zeichneQuickHinweis() {
  const el = $("todo-quick-hinweis");
  const roh = $("todo-quick-title").value.trim();
  // Ein von Hand gewaehltes Datum gewinnt – dann verwirrt der Hinweis nur
  const erkannt = roh && !$("todo-quick-date").value ? datumAusText(roh) : { datum: null };
  if (!erkannt.datum) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = `<span class="chip active">${esc(dateBadge(erkannt.datum)[1])} · ${esc(fmtDate(new Date(erkannt.datum + "T00:00:00")))}</span>` +
    (erkannt.titel ? "" : ` <span class="quick-warnung">nur ein Datum – der Titel fehlt noch</span>`);
}

async function quickAddTodo() {
  const titleEl = $("todo-quick-title");
  const dateEl = $("todo-quick-date");
  const roh = titleEl.value.trim();
  if (!roh) return;
  // Explizites Datumsfeld gewinnt; sonst zieht der Parser das Datum aus dem
  // Text und der Titel wird um die Datumsangabe bereinigt gespeichert.
  let title = roh, datum = dateEl.value || null;
  if (!datum) {
    const erkannt = datumAusText(roh);
    if (erkannt.datum && erkannt.titel) { datum = erkannt.datum; title = erkannt.titel; }
  }
  titleEl.disabled = true;
  try {
    const { data, error } = await db.from("todos")
      .insert({ user_id: user.id, title, due_date: datum }).select().single();
    if (error) throw error;
    titleEl.value = "";
    dateEl.value = "";
    zeichneQuickHinweis();
    ersetzeInListe(todos, data);
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
$("todo-quick-title").addEventListener("input", zeichneQuickHinweis);
$("todo-quick-date").addEventListener("input", zeichneQuickHinweis);

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
  entferneAusListe(todos, id);
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
  oeffneOverlay("todo-overlay");
  setTimeout(() => $("todo-f-title").focus(), 60);
}
function closeTodoModal() { schliesseOverlay("todo-overlay"); editingTodoId = null; }

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
    const { data, error } = await db.from("todos").update(patch).eq("id", editingTodoId).select().single();
    if (error) throw error;
    ersetzeInListe(todos, data);
    closeTodoModal();
    showToast("Gespeichert");
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
  stilleZeichnung();
  const container = $("notes-container");
  if (!container) return;
  let list = [...notes].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (activeNoteTag !== "Alle") list = list.filter((n) => extractTags(n.content).includes(activeNoteTag));
  container.innerHTML = list.length
    ? list.map(noteCardHTML).join("")
    : notesFehler
      ? fehlerHTML("notizen")
      : leerHTML(activeNoteTag !== "Alle" ? "Keine Notizen mit diesem Tag." : "Noch keine Notizen – trag oben etwas ein.");
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
    const { data, error } = await db.from("notes").insert({ user_id: user.id, content }).select().single();
    if (error) throw error;
    el.value = "";
    el.style.height = "";
    ersetzeInListe(notes, data);
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
  oeffneOverlay("note-overlay");
  setTimeout(() => {
    const ta = $("note-f-content");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 60);
}
function closeNoteModal() { schliesseOverlay("note-overlay"); editingNoteId = null; }

async function saveNoteModal() {
  const content = $("note-f-content").value.trim();
  if (!content) { showToast("Notiz ist leer"); return; }
  const btn = $("note-save-btn");
  btn.disabled = true;
  try {
    const { data, error } = await db.from("notes")
      .update({ content, updated_at: new Date().toISOString() }).eq("id", editingNoteId).select().single();
    if (error) throw error;
    ersetzeInListe(notes, data);
    closeNoteModal();
    showToast("Gespeichert");
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
  entferneAusListe(notes, id);
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

/* ---- Einnahmen ----
   Die App kannte lange nur Geld, das rausgeht. Hier steht die Gegenrichtung:
   was ist diesen Monat eingegangen, was ist raus und noch nicht bezahlt,
   was steht als Angebot oder Auftrag noch aus. */

function einnahmenZahlen() {
  const heute = todayMidnight();
  const monatsStart = new Date(heute.getFullYear(), heute.getMonth(), 1);
  let eingegangen = 0, offen = 0, aussicht = 0, aeltesteRechnung = null;
  projects.forEach((p) => {
    const wert = Number(p.order_value);
    if (!Number.isFinite(wert) || wert <= 0) return;
    if (p.payment_status === "bezahlt") {
      if (p.paid_on && new Date(p.paid_on + "T00:00:00") >= monatsStart) eingegangen += wert;
    } else if (p.payment_status === "Rechnung raus") {
      offen += wert;
      const tage = rechnungOffenSeit(p);
      if (tage !== null && (aeltesteRechnung === null || tage > aeltesteRechnung)) aeltesteRechnung = tage;
    } else if (p.payment_status === "Angebot raus" || p.payment_status === "beauftragt") {
      aussicht += wert;
    }
  });
  return { eingegangen, offen, aussicht, aeltesteRechnung };
}

function renderEinnahmen() {
  const box = $("einnahmen-panel");
  if (!box) return;
  // Ohne einen einzigen Auftragswert waere das Panel nur eine Reihe Nullen
  const hatWerte = projects.some((p) => Number(p.order_value) > 0);
  box.classList.toggle("hidden", !hatWerte);
  if (!hatWerte) return;

  const z = einnahmenZahlen();
  const monat = todayMidnight().toLocaleDateString("de-DE", { month: "long" });
  const zeilen = [
    { name: monat, wert: z.eingegangen, klasse: "ein" },
    { name: "offen", wert: z.offen, klasse: "offen", hinweis: z.aeltesteRechnung > 0 ? `längste seit ${z.aeltesteRechnung} Tagen` : "" },
    { name: "in Aussicht", wert: z.aussicht, klasse: "aussicht" },
  ];
  box.innerHTML = `
    <div class="einnahmen-kopf">Websaray</div>
    ${zeilen.map((r) => `
      <div class="einnahmen-zeile">
        <span class="einnahmen-name">${esc(r.name)}${r.hinweis ? ` <span class="einnahmen-hinweis">${esc(r.hinweis)}</span>` : ""}</span>
        <span class="einnahmen-wert ${r.klasse}">${fmt(r.wert)}</span>
      </div>`).join("")}`;
}

/* ---- Geld an Projekten ---- */
const GELD_KLASSE = {
  "Angebot raus": "geld-angebot",
  "beauftragt": "geld-beauftragt",
  "Rechnung raus": "geld-rechnung",
  "bezahlt": "geld-bezahlt",
};

// Tage seit Rechnungsstellung, solange sie offen ist – sonst null
function rechnungOffenSeit(p) {
  if (p.payment_status !== "Rechnung raus" || !p.invoiced_on) return null;
  return Math.round((todayMidnight() - new Date(p.invoiced_on + "T00:00:00")) / 864e5);
}

function geldZeile(p) {
  const stand = p.payment_status && p.payment_status !== "kein" ? p.payment_status : null;
  if (!stand && p.order_value == null) return "";
  const tage = rechnungOffenSeit(p);
  const zusatz = tage !== null && tage > 0 ? ` · seit ${tage} ${tage === 1 ? "Tag" : "Tagen"}` : "";
  return `
    <div class="project-geld">
      ${p.order_value != null ? `<span class="geld-wert">${fmt(p.order_value)}</span>` : ""}
      ${stand ? `<span class="geld-chip ${GELD_KLASSE[stand] || ""}">${esc(stand)}${zusatz}</span>` : ""}
    </div>`;
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
  const geld = geldZeile(p);
  // Kein Status-Chip mehr auf der Karte: der Status steht seit der Gruppierung
  // schon in der Überschrift darüber, ihn je Karte zu wiederholen ist Rauschen.
  return `
  <div class="project-card ${p.status === "fertig" ? "done" : ""}" data-id="${p.id}">
    <div class="project-top">
      <div class="project-name">${esc(p.name)}</div>
    </div>
    <div class="project-meta">${esc(metaParts.join(" · "))}</div>
    ${geld}
    ${p.note ? `<div class="project-note">${tagTextHTML(p.note)}</div>` : ""}
    ${p.link ? `<a class="project-link" href="${esc(p.link)}" target="_blank" rel="noopener">${svgIcon("link")}${esc(linkText)}</a>` : ""}
  </div>`;
}

// Reihenfolge der Gruppen: was läuft, was ansteht, was hängt, was durch ist.
const PROJEKT_GRUPPEN = ["in Arbeit", "offen", "wartet", "fertig"];

function renderProjects() {
  stilleZeichnung();
  const container = $("projects-container");
  if (!container) return;
  let list = sortProjects(projects);
  if (activeProjectKind !== "Alle") list = list.filter((p) => p.kind === activeProjectKind);
  if (!list.length) {
    container.innerHTML = projectsFehler
      ? fehlerHTML("projekte")
      : leerHTML(`Noch keine Projekte${activeProjectKind !== "Alle" ? " dieser Art" : ""} – tipp unten rechts auf „+“.`);
    return;
  }
  // Nach Status gruppieren statt flach auflisten: „was liegt gerade in Arbeit"
  // ist die Frage, mit der man den Tab öffnet – die soll man nicht aus
  // sechs einzelnen Chips zusammenlesen müssen.
  container.innerHTML = PROJEKT_GRUPPEN.map((status) => {
    const gruppe = list.filter((p) => p.status === status);
    if (!gruppe.length) return "";
    return `<div class="gruppen-kopf ${PROJECT_STATUS_CLASS[status] || ""}">${esc(status)}<span class="gruppen-zahl">${gruppe.length}</span></div>` +
      gruppe.map(projectCardHTML).join("");
  }).join("");
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
    $("project-f-value").value = p.order_value ?? "";
    $("project-f-pay").value = p.payment_status || "kein";
    $("project-f-invoiced").value = p.invoiced_on || "";
    $("project-f-paid").value = p.paid_on || "";
  } else {
    $("project-f-name").value = "";
    $("project-f-kind").value = "Eigenes";
    $("project-f-status").value = "offen";
    $("project-f-date").value = "";
    $("project-f-link").value = "";
    $("project-f-note").value = "";
    $("project-f-value").value = "";
    $("project-f-pay").value = "kein";
    $("project-f-invoiced").value = "";
    $("project-f-paid").value = "";
  }
  zeichneGeldFelder();
  oeffneOverlay("project-overlay");
  setTimeout(() => $("project-f-name").focus(), 60);
}

// Die Datumsfelder erscheinen erst, wenn der Geld-Status sie braucht – sonst
// stehen im Formular zwei Felder, die bei den meisten Projekten leer bleiben.
function zeichneGeldFelder() {
  const stand = $("project-f-pay").value;
  const rechnung = stand === "Rechnung raus" || stand === "bezahlt";
  const bezahlt = stand === "bezahlt";
  $("project-feld-rechnung").classList.toggle("hidden", !rechnung);
  $("project-feld-bezahlt").classList.toggle("hidden", !bezahlt);
  $("project-geld-daten").classList.toggle("hidden", !rechnung);
}
function closeProjectModal() { schliesseOverlay("project-overlay"); editingProjectId = null; }

async function saveProjectModal() {
  const name = $("project-f-name").value.trim();
  if (!name) { showToast("Bitte einen Namen eingeben"); return; }
  let link = $("project-f-link").value.trim();
  // "pixelsaray.vercel.app" eingetippt soll trotzdem klickbar sein
  if (link && !/^https?:\/\//i.test(link)) link = "https://" + link;
  const wert = $("project-f-value").value === "" ? null : Math.max(0, parseFloat($("project-f-value").value));
  const geldStand = $("project-f-pay").value;
  const row = {
    name,
    kind: $("project-f-kind").value,
    status: $("project-f-status").value,
    due_date: $("project-f-date").value || null,
    link: link || null,
    note: $("project-f-note").value.trim() || null,
    order_value: Number.isFinite(wert) ? wert : null,
    payment_status: geldStand,
    // Daten nur behalten, solange der Stand sie überhaupt kennt – sonst bliebe
    // ein Bezahlt-Datum stehen, nachdem der Stand zurückgesetzt wurde.
    invoiced_on: (geldStand === "Rechnung raus" || geldStand === "bezahlt") ? ($("project-f-invoiced").value || null) : null,
    paid_on: geldStand === "bezahlt" ? ($("project-f-paid").value || null) : null,
    updated_at: new Date().toISOString()
  };
  const btn = $("project-save-btn");
  btn.disabled = true;
  try {
    if (editingProjectId) {
      const { data, error } = await db.from("projects").update(row).eq("id", editingProjectId).select().single();
      if (error) throw error;
      ersetzeInListe(projects, data);
      showToast("Gespeichert");
    } else {
      const { data, error } = await db.from("projects").insert({ ...row, user_id: user.id }).select().single();
      if (error) throw error;
      ersetzeInListe(projects, data);
      showToast("Projekt angelegt");
    }
    closeProjectModal();
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
  entferneAusListe(projects, id);
  // Die Verknüpfung fällt serverseitig weg (FK on delete set null) – hier
  // dieselbe Wirkung lokal nachziehen, statt alle To-Dos erneut zu holen.
  todos.forEach((t) => { if (t.project_id === id) t.project_id = null; });
  renderAll();
}
$("project-save-btn").addEventListener("click", saveProjectModal);
$("project-cancel-btn").addEventListener("click", closeProjectModal);
$("project-f-pay").addEventListener("change", (e) => {
  // Beim Umstellen gleich das heutige Datum anbieten – meistens stimmt es,
  // und wenn nicht, steht das Feld ja offen da.
  const heute = toDateStr(todayMidnight());
  if (e.target.value === "Rechnung raus" && !$("project-f-invoiced").value) $("project-f-invoiced").value = heute;
  if (e.target.value === "bezahlt") {
    if (!$("project-f-invoiced").value) $("project-f-invoiced").value = heute;
    if (!$("project-f-paid").value) $("project-f-paid").value = heute;
  }
  zeichneGeldFelder();
});
$("project-delete-btn").addEventListener("click", () => deleteProject(editingProjectId));
$("project-overlay").addEventListener("click", (e) => { if (e.target.id === "project-overlay") closeProjectModal(); });

/* ================= TAG-ANSICHT ================= */
// Ein Tipp auf ein #tag – egal wo – zeigt alles, was es trägt: Projekte,
// To-Dos, Abos, Notizen. Das ist die Querverbindung zwischen den Bausteinen.

function closeTagView() { schliesseOverlay("tag-overlay"); }

// Ein Eintrag, vier mögliche Fenster. Tag-Ansicht und Suche teilen sich das Ziel.
function oeffneEintrag(art, id) {
  if (art === "projekt") openProjectModal(id);
  else if (art === "abo") openModal(id);
  else if (art === "todo") openTodoModal(id);
  else if (art === "note") openNoteModal(id);
  else if (art === "termin") openEventModal(id);
  else if (art === "modul") openModulModal(id);
}

// Aus der Sammelansicht heraus direkt ins jeweilige Bearbeiten-Fenster
function openTagRow(art, id) {
  closeTagView();
  oeffneEintrag(art, id);
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
  body.innerHTML = secs.join("") || leerHTML("Nichts weiter mit diesem Tag.");
  body.querySelectorAll(".tag-row").forEach((el) =>
    el.addEventListener("click", () => openTagRow(el.dataset.art, el.dataset.id)));
  oeffneOverlay("tag-overlay");
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

/* ================= NATUERLICH EINTRAGEN =================
   "Rechnung morgen" statt Titel tippen, Feld wechseln, Datum waehlen.
   Bewusst lokale Regeln statt KI-Aufruf: kostet nichts, ist sofort da und
   fuer Datumsangaben zuverlaessiger als ein Modell. Erkannt werden
   heute/morgen/uebermorgen, Wochentage, "in N Tagen/Wochen" und 15.8.-Daten.
   Uhrzeiten bleiben absichtlich im Titel stehen – To-Dos haben kein
   Zeitfeld, und ein stillschweigend verworfenes "14 Uhr" waere gelogen. */

const WOCHENTAGE = { sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6 };

function datumAusText(roh) {
  const heute = todayMidnight();
  let text = ` ${roh} `;
  let datum = null;
  const inTagen = (n) => { const d = new Date(heute); d.setDate(d.getDate() + n); return d; };
  // Erster Treffer gewinnt; die Reihenfolge stellt "uebermorgen" vor "morgen",
  // weil \b vor Umlauten greift und "morgen" sonst mitten im Wort traefe.
  const regeln = [
    [/(^|\s)übermorgen(?=\s|$)/i, () => inTagen(2)],
    [/(^|\s)morgen(?=\s|$)/i, () => inTagen(1)],
    [/(^|\s)heute(?=\s|$)/i, () => heute],
    [/(^|\s)in (\d{1,2}) tagen?(?=\s|$)/i, (m) => inTagen(parseInt(m[2], 10))],
    [/(^|\s)in (\d{1,2}) wochen?(?=\s|$)/i, (m) => inTagen(7 * parseInt(m[2], 10))],
    [/(^|\s)(?:am |nächsten |naechsten )?(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)(?=\s|$)/i,
      (m) => { // naechstes Vorkommen; heute gemeint waere "heute", also nie 0 Tage
        let diff = (WOCHENTAGE[m[2].toLowerCase()] - heute.getDay() + 7) % 7;
        return inTagen(diff === 0 ? 7 : diff);
      }],
    [/(^|\s)(?:am )?(\d{1,2})\.(\d{1,2})\.(\d{4})?(?=\s|$)/, (m) => {
      const tagN = parseInt(m[2], 10), monatN = parseInt(m[3], 10);
      const jahr = m[4] ? parseInt(m[4], 10) : heute.getFullYear();
      let d = new Date(jahr, monatN - 1, tagN);
      // Ohne Jahr gilt das naechste Vorkommen – "15.1." im August meint Januar
      if (!m[4] && d < heute) d = new Date(jahr + 1, monatN - 1, tagN);
      // Date rechnet 31.02. still in Maerz um – das ist dann keine Angabe
      return d.getDate() === tagN && d.getMonth() === monatN - 1 ? d : null;
    }],
  ];
  for (const [re, mach] of regeln) {
    const m = text.match(re);
    if (!m) continue;
    const d = mach(m);
    if (!d) continue;
    datum = toDateStr(d);
    text = text.replace(re, " ");
    break;
  }
  const titel = text.replace(/\s+/g, " ").trim();
  // Bestand der Text nur aus der Datumsangabe, bleibt der Titel leer –
  // der Aufrufer entscheidet, was das heisst.
  return { datum, titel };
}

/* ---- Uhrzeit im Satz – nur fuer Termine, To-Dos haben kein Zeitfeld ---- */
function zeitAusText(roh) {
  let text = ` ${roh} `;
  let zeit = null;
  const regeln = [
    /(^|\s)um (\d{1,2})[:.](\d{2})(?=\s|$)/i,
    /(^|\s)(\d{1,2})[:.](\d{2}) ?uhr(?=\s|$)/i,
    /(^|\s)um (\d{1,2})(?=\s|$)/i,
    /(^|\s)(\d{1,2}) ?uhr(?=\s|$)/i,
    /(^|\s)(\d{1,2}):(\d{2})(?=\s|$)/,
  ];
  for (const re of regeln) {
    const m = text.match(re);
    if (!m) continue;
    const std = parseInt(m[2], 10);
    const min = m[3] ? parseInt(m[3], 10) : 0;
    if (std > 23 || min > 59) continue;
    zeit = `${String(std).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    text = text.replace(re, " ");
    break;
  }
  const { datum, titel } = datumAusText(text.replace(/\s+/g, " ").trim());
  return { datum, zeit, titel };
}

/* ================= UNI-PLANER =================
   Ein Modul je Zeile, die Klausur ist der Termin, der zaehlt. Signal ab
   sieben Tagen vor der Klausur – frueher waere Rauschen, spaeter zu spaet.
   Nach der Klausur erinnert die App ans Ergebnis, statt es zu vergessen. */

function naechsteKlausur() {
  const heuteStr = toDateStr(todayMidnight());
  const kommende = uniModule
    .filter((m) => m.status === "laeuft" && m.klausur_am && m.klausur_am >= heuteStr)
    .sort((a, b) => (a.klausur_am < b.klausur_am ? -1 : 1));
  if (!kommende.length) return null;
  const m = kommende[0];
  const tage = Math.round((new Date(m.klausur_am + "T00:00:00") - todayMidnight()) / 864e5);
  return { m, tage };
}

function renderUni() {
  const box = $("uni-inhalt");
  if (!box) return;
  if (uniFehler && !uniModule.length) { box.innerHTML = fehlerHTML("uni"); return; }
  if (!uniModule.length) {
    box.innerHTML = `<div class="coach-karte"><div class="coach-titel">Uni</div>
      <div class="coach-text">Leg deine Module oben an – mit Klausurtermin direkt im Satz:
      „Analysis II 19.8. 9 Uhr". Klausuren erscheinen dann in Kalender, Übersicht und Erinnerung.</div></div>`;
    return;
  }
  const heuteStr = toDateStr(todayMidnight());
  const kl = naechsteKlausur();
  const laufend = uniModule.filter((m) => m.status === "laeuft")
    .sort((a, b) => (a.klausur_am || "9999") < (b.klausur_am || "9999") ? -1 : 1);
  const vorbei = uniModule.filter((m) => m.status !== "laeuft");

  const kopf = kl
    ? `Nächste Klausur: <b>${esc(kl.m.name)}</b> ${kl.tage === 0 ? "— HEUTE" : kl.tage === 1 ? "— morgen" : `in ${kl.tage} Tagen`}${kl.m.klausur_um ? ` um ${esc(kl.m.klausur_um)} Uhr` : ""}.`
    : `Kein Klausurtermin eingetragen. ${laufend.length ? "Trag ihn ein, sobald er feststeht – dann zählt die App mit." : ""}`;

  const modulZeile = (m) => {
    const ergebnisOffen = m.status === "laeuft" && m.klausur_am && m.klausur_am < heuteStr;
    const rechts = m.status === "bestanden" ? `bestanden${m.ergebnis ? ` · ${esc(m.ergebnis)}` : ""}`
      : m.status === "durchgefallen" ? `<span class="sig">durchgefallen</span>`
      : ergebnisOffen ? `<span class="sig">Ergebnis eintragen?</span>`
      : m.klausur_am ? `Klausur ${esc(kurzDatum(new Date(m.klausur_am + "T00:00:00")))}${m.klausur_um ? ` · ${esc(m.klausur_um)}` : ""}`
      : "kein Termin";
    return `<button class="fit-uebung" data-modul="${m.id}">
      <span class="fit-uebung-name">${esc(m.name)}</span>
      <span class="fit-uebung-ziel">${rechts}</span>
    </button>`;
  };

  box.innerHTML = `
    <div class="coach-karte"><div class="coach-titel">Uni</div><div class="coach-text">${kopf}</div></div>
    ${laufend.length ? `<div class="section-head"><h2>Läuft</h2></div><div class="list" style="margin-bottom:8px">${laufend.map(modulZeile).join("")}</div>` : ""}
    ${vorbei.length ? `<div class="section-head"><h2>Abgeschlossen</h2></div><div class="list" style="opacity:.55">${vorbei.map(modulZeile).join("")}</div>` : ""}`;
  box.querySelectorAll("[data-modul]").forEach((el) =>
    el.addEventListener("click", () => openModulModal(el.dataset.modul)));
}

function zeichneModulHinweis() {
  const el = $("modul-quick-hinweis");
  const roh = $("modul-quick-name").value.trim();
  const erkannt = roh ? zeitAusText(roh) : { datum: null, zeit: null, titel: "" };
  if (!erkannt.datum) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = `<span class="chip active">Klausur ${esc(fmtDate(new Date(erkannt.datum + "T00:00:00")))}${erkannt.zeit ? " · " + esc(erkannt.zeit) : ""}</span>` +
    (erkannt.titel ? "" : ` <span class="quick-warnung">nur ein Datum – der Modulname fehlt</span>`);
}

async function quickAddModul() {
  const el = $("modul-quick-name");
  const roh = el.value.trim();
  if (!roh) return;
  const erkannt = zeitAusText(roh);
  const name = erkannt.datum && erkannt.titel ? erkannt.titel : roh;
  el.disabled = true;
  try {
    const { data, error } = await db.from("uni_module")
      .insert({ user_id: user.id, name, status: "laeuft",
                klausur_am: erkannt.datum, klausur_um: erkannt.datum ? erkannt.zeit : null })
      .select().single();
    if (error) throw error;
    data.klausur_um = data.klausur_um ? String(data.klausur_um).slice(0, 5) : null;
    uniModule.push(data);
    el.value = "";
    zeichneModulHinweis();
    renderAll();
    showToast("Modul angelegt");
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    el.disabled = false;
    el.focus();
  }
}

function openModulModal(id) {
  editingModulId = id || null;
  $("modul-modal-title").textContent = id ? "Modul bearbeiten" : "Modul anlegen";
  $("modul-delete-btn").classList.toggle("hidden", !id);
  const m = id ? uniModule.find((x) => x.id === id) : null;
  $("modul-f-name").value = m ? m.name : "";
  $("modul-f-datum").value = m?.klausur_am || "";
  $("modul-f-zeit").value = m?.klausur_um || "";
  $("modul-f-status").value = m ? m.status : "laeuft";
  $("modul-f-ergebnis").value = m?.ergebnis || "";
  $("modul-f-note").value = m?.note || "";
  oeffneOverlay("modul-overlay");
  setTimeout(() => $("modul-f-name").focus(), 60);
}
function closeModulModal() { schliesseOverlay("modul-overlay"); editingModulId = null; }

async function saveModulModal() {
  const name = $("modul-f-name").value.trim();
  if (!name) { showToast("Bitte einen Namen eingeben"); return; }
  const row = {
    name,
    status: $("modul-f-status").value,
    klausur_am: $("modul-f-datum").value || null,
    klausur_um: $("modul-f-datum").value ? ($("modul-f-zeit").value || null) : null,
    ergebnis: $("modul-f-ergebnis").value.trim() || null,
    note: $("modul-f-note").value.trim() || null,
    updated_at: new Date().toISOString(),
  };
  const btn = $("modul-save-btn");
  btn.disabled = true;
  try {
    if (editingModulId) {
      const { data, error } = await db.from("uni_module").update(row).eq("id", editingModulId).select().single();
      if (error) throw error;
      data.klausur_um = data.klausur_um ? String(data.klausur_um).slice(0, 5) : null;
      ersetzeInListe(uniModule, data);
    } else {
      const { data, error } = await db.from("uni_module").insert({ ...row, user_id: user.id }).select().single();
      if (error) throw error;
      data.klausur_um = data.klausur_um ? String(data.klausur_um).slice(0, 5) : null;
      uniModule.push(data);
    }
    closeModulModal();
    renderAll();
    showToast("Gespeichert");
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    btn.disabled = false;
  }
}

async function deleteModul(id) {
  const m = uniModule.find((x) => x.id === id);
  if (!m) return;
  if (!confirm(`„${m.name}“ wirklich löschen?`)) return;
  const { error } = await db.from("uni_module").delete().eq("id", id);
  if (error) { showToast("Fehler beim Löschen"); return; }
  entferneAusListe(uniModule, id);
  closeModulModal();
  renderAll();
  showToast("Gelöscht");
}

$("modul-quick-add").addEventListener("click", quickAddModul);
$("modul-quick-name").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAddModul(); });
$("modul-quick-name").addEventListener("input", zeichneModulHinweis);
$("modul-save-btn").addEventListener("click", saveModulModal);
$("modul-cancel-btn").addEventListener("click", closeModulModal);
$("modul-delete-btn").addEventListener("click", () => deleteModul(editingModulId));
$("modul-overlay").addEventListener("click", (e) => { if (e.target.id === "modul-overlay") closeModulModal(); });

/* ================= FITNESS-COACH =================
   Jede Wiederholung wird eingetragen, der Coach rechnet – regelbasiert,
   ohne KI-Aufruf, also ohne laufende Kosten. Die Regeln:
   alle Ziel-Saetze voll geschafft  -> Gewicht sofort um die Schrittweite hoch
   angefangen, aber nicht geschafft -> Fehlversuch (beim Beenden gezaehlt)
   zweiter Fehlversuch in Folge     -> Gewicht zwei Schritte runter, neuer Anlauf */

const SPLIT_VORLAGEN = {
  ppl: { tage: [["Push", ["Bankdrücken", "Schulterdrücken", "Dips"]],
                ["Pull", ["Latzug", "Rudern", "Bizeps-Curls"]],
                ["Beine", ["Kniebeugen", "Beinpresse", "Wadenheben"]]] },
  okuk: { tage: [["Oberkörper", ["Bankdrücken", "Rudern", "Schulterdrücken", "Latzug"]],
                 ["Unterkörper", ["Kniebeugen", "Beinpresse", "Beinbeuger", "Wadenheben"]]] },
  gk: { tage: [["Ganzkörper", ["Kniebeugen", "Bankdrücken", "Rudern", "Schulterdrücken"]]] },
  eigen: { tage: [["Tag 1", []]] },
};

// Gewichte deutsch: 62,5 kg statt 62.5 kg
function alsKg(n) { return String(n).replace(".", ",") + " kg"; }

function uebungenZuTag(tagId) {
  return fitnessUebungen.filter((u) => u.tag_id === tagId).sort((a, b) => a.position - b.position);
}
function saetzeHeute(uebungId) {
  const h = toDateStr(todayMidnight());
  return fitnessSaetze.filter((s2) => s2.uebung_id === uebungId && s2.datum === h)
    .sort((a, b) => a.satz_nr - b.satz_nr);
}
function letztesDatumZuTag(tagId) {
  const ids = new Set(uebungenZuTag(tagId).map((u) => u.id));
  let max = null;
  fitnessSaetze.forEach((s2) => { if (ids.has(s2.uebung_id) && (!max || s2.datum > max)) max = s2.datum; });
  return max;
}
// Rotation: dran ist der Tag nach dem zuletzt trainierten; nie trainiert -> der erste
function dranTag() {
  if (!fitnessTage.length) return null;
  let letztTag = null, letztDatum = null;
  fitnessTage.forEach((t2) => {
    const d = letztesDatumZuTag(t2.id);
    if (d && (!letztDatum || d > letztDatum)) { letztDatum = d; letztTag = t2; }
  });
  if (!letztTag) return fitnessTage[0];
  const i = fitnessTage.findIndex((t2) => t2.id === letztTag.id);
  return fitnessTage[(i + 1) % fitnessTage.length];
}
function tageSeitTraining() {
  let max = null;
  fitnessSaetze.forEach((s2) => { if (!max || s2.datum > max) max = s2.datum; });
  return max === null ? null : Math.round((todayMidnight() - new Date(max + "T00:00:00")) / 864e5);
}
function heuteTrainiert() {
  const h = toDateStr(todayMidnight());
  return fitnessSaetze.some((s2) => s2.datum === h);
}
// Die gefuellte Signal-Kachel: Plan vorhanden, heute noch nichts, und der
// letzte Besuch ist zwei Tage oder laenger her (Bedos 3x/Woche-Rhythmus).
function fitnessDran() {
  if (!fitnessTage.length) return false;
  const seit = tageSeitTraining();
  return !heuteTrainiert() && (seit === null || seit >= 2);
}

async function splitEinrichten(schluessel) {
  const v = SPLIT_VORLAGEN[schluessel];
  if (!v) return;
  try {
    for (let p2 = 0; p2 < v.tage.length; p2++) {
      const [nameT, uebs] = v.tage[p2];
      const { data: tagRow, error } = await db.from("fitness_tage")
        .insert({ user_id: user.id, name: nameT, position: p2 }).select().single();
      if (error) throw error;
      fitnessTage.push(tagRow);
      for (let q = 0; q < uebs.length; q++) {
        const { data: uRow, error: e2 } = await db.from("fitness_uebungen")
          .insert({ user_id: user.id, tag_id: tagRow.id, name: uebs[q], position: q,
                    ziel_saetze: 3, ziel_wdh: 8, gewicht: null, schritt: 2.5, fehlversuche: 0 })
          .select().single();
        if (e2) throw e2;
        uRow.gewicht = uRow.gewicht == null ? null : Number(uRow.gewicht);
        uRow.schritt = Number(uRow.schritt) || 2.5;
        fitnessUebungen.push(uRow);
      }
    }
    renderFitness();
    renderHome();
    showToast("Plan steht — gutes Training");
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Einrichten");
  }
}

function renderFitness() {
  const box = $("fitness-inhalt");
  if (!box) return;
  if (fitnessFehler && !fitnessTage.length) { box.innerHTML = fehlerHTML("fitness"); return; }
  if (!fitnessTage.length) { renderFitnessEinrichtung(box); return; }
  if (trainingTagId) { renderTraining(box); return; }
  renderFitnessUebersicht(box);
}

function renderFitnessEinrichtung(box) {
  box.innerHTML = `
    <div class="coach-karte"><div class="coach-titel">Coach</div>
      <div class="coach-text">Einmal einrichten, dann rechnet der Coach mit: jeder Satz wird
      gespeichert, und schaffst du alle, schlägt er beim nächsten Mal mehr Gewicht vor.</div></div>
    <div class="section-head"><h2>Wie trainierst du?</h2></div>
    <div class="list">
      <button class="fit-uebung fit-split" data-split="ppl"><span class="fit-uebung-name">Push / Pull / Beine</span><span class="fit-uebung-ziel">3 Tage</span></button>
      <button class="fit-uebung fit-split" data-split="okuk"><span class="fit-uebung-name">Oberkörper / Unterkörper</span><span class="fit-uebung-ziel">2 Tage</span></button>
      <button class="fit-uebung fit-split" data-split="gk"><span class="fit-uebung-name">Ganzkörper</span><span class="fit-uebung-ziel">1 Tag</span></button>
      <button class="fit-uebung fit-split" data-split="eigen"><span class="fit-uebung-name">Eigener Plan</span><span class="fit-uebung-ziel">leer starten</span></button>
    </div>
    <div class="hint-text">Übungen, Sätze und Gewichte kannst du danach jederzeit anpassen.</div>`;
  box.querySelectorAll(".fit-split").forEach((b) =>
    b.addEventListener("click", () => splitEinrichten(b.dataset.split)));
}

function renderFitnessUebersicht(box) {
  const dran = dranTag();
  const seit = tageSeitTraining();
  const heute = heuteTrainiert();
  const coachText = heute
    ? `Heute schon trainiert – stark. Als Nächstes wäre <b>${esc(dran.name)}</b> dran.`
    : seit === null
      ? `Erster Einsatz: heute <b>${esc(dran.name)}</b>. Die Gewichte trägst du im Training ein – ab dann rechnet der Coach.`
      : `Dran: <b>${esc(dran.name)}</b> · zuletzt trainiert ${seit === 1 ? "gestern" : `vor ${seit} Tagen`}.`;
  box.innerHTML = `
    <div class="coach-karte">
      <div class="coach-titel">Coach</div>
      <div class="coach-text">${coachText}</div>
      <div class="chip-row" style="margin:12px 0 0">
        ${fitnessTage.map((t2) => `<button class="chip ${t2.id === dran.id && !heute ? "active" : ""}" data-start="${t2.id}">${esc(t2.name)} starten</button>`).join("")}
      </div>
    </div>
    ${fitnessTage.map((t2) => {
      const letzt = letztesDatumZuTag(t2.id);
      return `
      <div class="section-head"><h2>${esc(t2.name)}</h2><span class="head-date">${letzt ? `zuletzt ${kurzDatum(new Date(letzt + "T00:00:00"))}` : "noch nie"}</span></div>
      <div class="list" style="margin-bottom:8px">
        ${uebungenZuTag(t2.id).map((u) => `
        <div class="fit-uebung" data-id="${u.id}">
          <span class="fit-uebung-name">${esc(u.name)}</span>
          <span class="fit-uebung-ziel">${u.ziel_saetze}×${u.ziel_wdh}${u.gewicht != null ? ` · ${alsKg(u.gewicht)}` : ""}${u.fehlversuche ? ` · <span class="sig">${u.fehlversuche + 1}. Anlauf</span>` : ""}</span>
        </div>`).join("") || `<div class="hint-text">Noch keine Übungen – leg unten eine an.</div>`}
        <button class="btn subtle fit-neu" data-tag="${t2.id}">+ Übung</button>
      </div>`;
    }).join("")}`;
  box.querySelectorAll("[data-start]").forEach((b) =>
    b.addEventListener("click", () => { trainingTagId = b.dataset.start; trainingWdh = {}; renderFitness(); }));
  box.querySelectorAll(".fit-uebung[data-id]").forEach((el) =>
    el.addEventListener("click", () => openUebungModal(el.dataset.id)));
  box.querySelectorAll(".fit-neu").forEach((b) =>
    b.addEventListener("click", () => openUebungModal(null, b.dataset.tag)));
}

function renderTraining(box) {
  const tag = fitnessTage.find((t2) => t2.id === trainingTagId);
  if (!tag) { trainingTagId = null; renderFitnessUebersicht(box); return; }
  const uebs = uebungenZuTag(tag.id);
  box.innerHTML = `
    <div class="coach-karte">
      <div class="coach-titel">Training läuft — ${esc(tag.name)}</div>
      <div class="coach-text">Satz geschafft? Häkchen. Weniger Wiederholungen geschafft? Erst − tippen, dann Häkchen.</div>
    </div>
    ${uebs.map((u) => {
      const gemacht = saetzeHeute(u.id);
      const naechster = gemacht.length + 1;
      const wdh = trainingWdh[u.id] ?? u.ziel_wdh;
      const alleVoll = gemacht.length >= u.ziel_saetze && gemacht.every((s2) => s2.wdh >= u.ziel_wdh);
      return `
      <div class="fit-block" data-id="${u.id}">
        <div class="fit-block-kopf">
          <span class="fit-block-name">${esc(u.name)}</span>
          <span class="fit-gewicht"><input type="number" step="0.5" min="0" inputmode="decimal" value="${u.gewicht ?? ""}" placeholder="kg" data-gewicht="${u.id}" aria-label="Gewicht in kg"> kg</span>
        </div>
        ${Array.from({ length: u.ziel_saetze }, (_, i) => {
          const nr = i + 1;
          const done = gemacht.find((s2) => s2.satz_nr === nr);
          const aktiv = !done && nr === naechster;
          return `
          <div class="fit-satz ${done ? "done" : ""} ${aktiv ? "aktiv" : ""}">
            <span class="fit-satz-nr">Satz ${nr}</span>
            ${done ? `<span class="fit-satz-wdh">${done.wdh} Wdh${done.wdh < u.ziel_wdh ? ` <span class="sig">von ${u.ziel_wdh}</span>` : ""}</span>`
              : aktiv ? `<span class="fit-stepper"><button class="fit-minus" aria-label="Weniger Wiederholungen">−</button><span class="fit-wdh">${wdh}</span><button class="fit-plus" aria-label="Mehr Wiederholungen">+</button></span>`
              : `<span class="fit-satz-wdh" style="color:var(--text-dim)">${u.ziel_wdh} Wdh</span>`}
            ${done ? `<span class="todo-check checked"></span>` : aktiv ? `<button class="todo-check fit-check" aria-label="Satz geschafft"></button>` : `<span class="todo-check" style="opacity:.35"></span>`}
            ${done && ebenSatz === u.id + ":" + nr ? `<span class="zeilen-sweep"></span>` : ""}
          </div>`;
        }).join("")}
        ${alleVoll ? `<div class="coach-hinweis">✓ ${u.ziel_saetze}×${u.ziel_wdh} geschafft — nächstes Mal ${u.gewicht != null ? alsKg(u.gewicht) : "mehr"}</div>` : ""}
      </div>`;
    }).join("")}
    <button class="btn block" id="fit-beenden">Training beenden</button>`;

  box.querySelectorAll("[data-gewicht]").forEach((inp) =>
    inp.addEventListener("change", async () => {
      const u = fitnessUebungen.find((x) => x.id === inp.dataset.gewicht);
      const wert = inp.value === "" ? null : Math.max(0, parseFloat(inp.value));
      const { data, error } = await db.from("fitness_uebungen")
        .update({ gewicht: wert, updated_at: new Date().toISOString() }).eq("id", u.id).select().single();
      if (error) { showToast("Fehler beim Speichern"); return; }
      data.gewicht = data.gewicht == null ? null : Number(data.gewicht);
      data.schritt = Number(data.schritt) || 2.5;
      ersetzeInListe(fitnessUebungen, data);
    }));
  box.querySelectorAll(".fit-block").forEach((block) => {
    const id = block.dataset.id;
    block.querySelector(".fit-minus")?.addEventListener("click", () => {
      const u = fitnessUebungen.find((x) => x.id === id);
      trainingWdh[id] = Math.max(0, (trainingWdh[id] ?? u.ziel_wdh) - 1);
      block.querySelector(".fit-wdh").textContent = trainingWdh[id];
    });
    block.querySelector(".fit-plus")?.addEventListener("click", () => {
      const u = fitnessUebungen.find((x) => x.id === id);
      trainingWdh[id] = Math.min(u.ziel_wdh * 2, (trainingWdh[id] ?? u.ziel_wdh) + 1);
      block.querySelector(".fit-wdh").textContent = trainingWdh[id];
    });
    block.querySelector(".fit-check")?.addEventListener("click", () => satzAbhaken(id));
  });
  $("fit-beenden").addEventListener("click", beendeTraining);
}

async function satzAbhaken(uebungId) {
  const u = fitnessUebungen.find((x) => x.id === uebungId);
  const gemacht = saetzeHeute(uebungId);
  const nr = gemacht.length + 1;
  if (nr > u.ziel_saetze) return;
  if (u.gewicht == null) { showToast("Erst das Gewicht eintragen"); return; }
  const wdh = trainingWdh[uebungId] ?? u.ziel_wdh;
  const { data, error } = await db.from("fitness_saetze")
    .insert({ user_id: user.id, uebung_id: uebungId, datum: toDateStr(todayMidnight()), satz_nr: nr, gewicht: u.gewicht, wdh })
    .select().single();
  if (error) { showToast("Fehler beim Speichern"); console.error(error); return; }
  data.gewicht = data.gewicht == null ? null : Number(data.gewicht);
  fitnessSaetze.push(data);
  delete trainingWdh[uebungId];
  ebenSatz = uebungId + ":" + nr;
  clearTimeout(satzTimer);
  satzTimer = setTimeout(() => { ebenSatz = null; }, 600);
  // Alle Ziel-Saetze voll geschafft: SOFORT steigern – das ist der Coach-Moment,
  // die Zeile darunter zeigt direkt das neue Gewicht fuers naechste Mal.
  const alle = saetzeHeute(uebungId);
  if (alle.length >= u.ziel_saetze && alle.every((s2) => s2.wdh >= u.ziel_wdh)) {
    const neu = Math.round((u.gewicht + u.schritt) * 2) / 2;
    const { data: upd, error: e2 } = await db.from("fitness_uebungen")
      .update({ gewicht: neu, fehlversuche: 0, updated_at: new Date().toISOString() })
      .eq("id", uebungId).select().single();
    if (!e2 && upd) {
      upd.gewicht = Number(upd.gewicht);
      upd.schritt = Number(upd.schritt) || 2.5;
      ersetzeInListe(fitnessUebungen, upd);
    }
  }
  renderFitness();
  renderHome();
}

async function beendeTraining() {
  const uebs = uebungenZuTag(trainingTagId);
  for (const u of uebs) {
    const gemacht = saetzeHeute(u.id);
    const geschafft = gemacht.length >= u.ziel_saetze && gemacht.every((s2) => s2.wdh >= u.ziel_wdh);
    // Nichts angefasst: kein Urteil. Geschafft: schon beim letzten Satz gesteigert.
    if (!gemacht.length || geschafft) continue;
    let patch;
    if (u.fehlversuche + 1 >= 2 && u.gewicht != null) {
      const neu = Math.max(u.schritt, Math.round((u.gewicht - 2 * u.schritt) * 2) / 2);
      patch = { gewicht: neu, fehlversuche: 0 };
      showToast(`${u.name}: runter auf ${alsKg(neu)} — neuer Anlauf`);
    } else {
      patch = { fehlversuche: u.fehlversuche + 1 };
    }
    const { data, error } = await db.from("fitness_uebungen")
      .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", u.id).select().single();
    if (!error && data) {
      data.gewicht = data.gewicht == null ? null : Number(data.gewicht);
      data.schritt = Number(data.schritt) || 2.5;
      ersetzeInListe(fitnessUebungen, data);
    }
  }
  trainingTagId = null;
  renderFitness();
  renderHome();
  showToast("Training gespeichert");
}

/* ---- Uebung anlegen/bearbeiten ---- */
function openUebungModal(id, tagId) {
  editingUebungId = id || null;
  uebungNeuTagId = tagId || null;
  $("uebung-modal-title").textContent = id ? "Übung bearbeiten" : "Übung anlegen";
  $("uebung-delete-btn").classList.toggle("hidden", !id);
  const u = id ? fitnessUebungen.find((x) => x.id === id) : null;
  $("uebung-f-name").value = u ? u.name : "";
  $("uebung-f-saetze").value = u ? u.ziel_saetze : 3;
  $("uebung-f-wdh").value = u ? u.ziel_wdh : 8;
  $("uebung-f-gewicht").value = u && u.gewicht != null ? u.gewicht : "";
  $("uebung-f-schritt").value = u ? u.schritt : 2.5;
  oeffneOverlay("uebung-overlay");
  setTimeout(() => $("uebung-f-name").focus(), 60);
}
function closeUebungModal() { schliesseOverlay("uebung-overlay"); editingUebungId = null; uebungNeuTagId = null; }

async function saveUebungModal() {
  const name = $("uebung-f-name").value.trim();
  if (!name) { showToast("Bitte einen Namen eingeben"); return; }
  const saetze = Math.min(10, Math.max(1, parseInt($("uebung-f-saetze").value, 10) || 3));
  const wdh = Math.min(100, Math.max(1, parseInt($("uebung-f-wdh").value, 10) || 8));
  const gewicht = $("uebung-f-gewicht").value === "" ? null : Math.max(0, parseFloat($("uebung-f-gewicht").value));
  const schritt = Math.max(0.5, parseFloat($("uebung-f-schritt").value) || 2.5);
  const btn = $("uebung-save-btn");
  btn.disabled = true;
  try {
    if (editingUebungId) {
      const { data, error } = await db.from("fitness_uebungen")
        .update({ name, ziel_saetze: saetze, ziel_wdh: wdh, gewicht, schritt, updated_at: new Date().toISOString() })
        .eq("id", editingUebungId).select().single();
      if (error) throw error;
      data.gewicht = data.gewicht == null ? null : Number(data.gewicht);
      data.schritt = Number(data.schritt) || 2.5;
      ersetzeInListe(fitnessUebungen, data);
    } else {
      const position = uebungenZuTag(uebungNeuTagId).length;
      const { data, error } = await db.from("fitness_uebungen")
        .insert({ user_id: user.id, tag_id: uebungNeuTagId, name, position,
                  ziel_saetze: saetze, ziel_wdh: wdh, gewicht, schritt, fehlversuche: 0 })
        .select().single();
      if (error) throw error;
      data.gewicht = data.gewicht == null ? null : Number(data.gewicht);
      data.schritt = Number(data.schritt) || 2.5;
      fitnessUebungen.push(data);
    }
    closeUebungModal();
    renderFitness();
    showToast("Gespeichert");
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    btn.disabled = false;
  }
}

async function deleteUebung(id) {
  const u = fitnessUebungen.find((x) => x.id === id);
  if (!u) return;
  if (!confirm(`„${u.name}“ samt Historie löschen?`)) return;
  const { error } = await db.from("fitness_uebungen").delete().eq("id", id);
  if (error) { showToast("Fehler beim Löschen"); return; }
  entferneAusListe(fitnessUebungen, id);
  fitnessSaetze = fitnessSaetze.filter((s2) => s2.uebung_id !== id);
  closeUebungModal();
  renderFitness();
  renderHome();
  showToast("Gelöscht");
}

$("uebung-save-btn").addEventListener("click", saveUebungModal);
$("uebung-cancel-btn").addEventListener("click", closeUebungModal);
$("uebung-delete-btn").addEventListener("click", () => deleteUebung(editingUebungId));
$("uebung-overlay").addEventListener("click", (e) => { if (e.target.id === "uebung-overlay") closeUebungModal(); });

/* ================= TERMINE =================
   Eigene Kalender-Eintraege – im Gegensatz zu den Google-Terminen voll
   bearbeitbar. Die Schnelleingabe versteht Tag UND Uhrzeit aus dem Satz. */

function zeichneTerminHinweis() {
  const el = $("termin-quick-hinweis");
  const roh = $("termin-quick-titel").value.trim();
  const erkannt = roh ? zeitAusText(roh) : { datum: null, zeit: null, titel: "" };
  if (!erkannt.datum && !erkannt.zeit) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const datum = erkannt.datum || toDateStr(todayMidnight());
  el.innerHTML = `<span class="chip active">${esc(dateBadge(datum)[1])} · ${esc(fmtDate(new Date(datum + "T00:00:00")))}${erkannt.zeit ? " · " + esc(erkannt.zeit) : ""}</span>` +
    (erkannt.titel ? "" : ` <span class="quick-warnung">nur wann – das Was fehlt noch</span>`);
}

async function quickAddTermin() {
  const el = $("termin-quick-titel");
  const roh = el.value.trim();
  if (!roh) return;
  const erkannt = zeitAusText(roh);
  const titel = erkannt.titel || roh;
  // Ohne erkennbaren Tag gilt heute – der Hinweis zeigt das vorher an,
  // und im Termin-Fenster laesst es sich jederzeit korrigieren.
  const datum = erkannt.datum || toDateStr(todayMidnight());
  el.disabled = true;
  try {
    const { data, error } = await db.from("events")
      .insert({ user_id: user.id, title: titel, date: datum, time: erkannt.zeit }).select().single();
    if (error) throw error;
    data.time = data.time ? String(data.time).slice(0, 5) : null;
    ersetzeInListe(events, data);
    el.value = "";
    zeichneTerminHinweis();
    renderAll();
    showToast("Termin eingetragen");
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    el.disabled = false;
    el.focus();
  }
}

function openEventModal(id) {
  editingEventId = id || null;
  $("event-modal-title").textContent = id ? "Termin bearbeiten" : "Termin anlegen";
  $("event-delete-btn").classList.toggle("hidden", !id);
  if (id) {
    const ev = events.find((x) => x.id === id);
    if (!ev) return;
    $("event-f-title").value = ev.title;
    $("event-f-date").value = ev.date;
    $("event-f-time").value = ev.time || "";
    $("event-f-note").value = ev.note || "";
  } else {
    $("event-f-title").value = "";
    $("event-f-date").value = toDateStr(todayMidnight());
    $("event-f-time").value = "";
    $("event-f-note").value = "";
  }
  oeffneOverlay("event-overlay");
  setTimeout(() => $("event-f-title").focus(), 60);
}
function closeEventModal() { schliesseOverlay("event-overlay"); editingEventId = null; }

async function saveEventModal() {
  const titel = $("event-f-title").value.trim();
  const datum = $("event-f-date").value;
  if (!titel || !datum) { showToast("Bitte Titel und Datum ausfüllen"); return; }
  const row = {
    title: titel,
    date: datum,
    time: $("event-f-time").value || null,
    note: $("event-f-note").value.trim() || null,
    updated_at: new Date().toISOString(),
  };
  const btn = $("event-save-btn");
  btn.disabled = true;
  try {
    if (editingEventId) {
      const { data, error } = await db.from("events").update(row).eq("id", editingEventId).select().single();
      if (error) throw error;
      data.time = data.time ? String(data.time).slice(0, 5) : null;
      ersetzeInListe(events, data);
      showToast("Gespeichert");
    } else {
      const { data, error } = await db.from("events").insert({ ...row, user_id: user.id }).select().single();
      if (error) throw error;
      data.time = data.time ? String(data.time).slice(0, 5) : null;
      ersetzeInListe(events, data);
      showToast("Termin eingetragen");
    }
    closeEventModal();
    renderAll();
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    btn.disabled = false;
  }
}

async function deleteEvent(id) {
  const ev = events.find((x) => x.id === id);
  if (!ev) return;
  if (!confirm(`„${ev.title}“ wirklich löschen?`)) return;
  const { error } = await db.from("events").delete().eq("id", id);
  if (error) { showToast("Fehler beim Löschen"); return; }
  entferneAusListe(events, id);
  closeEventModal();
  renderAll();
  showToast("Gelöscht");
}

$("termin-quick-add").addEventListener("click", quickAddTermin);
$("termin-quick-titel").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAddTermin(); });
$("termin-quick-titel").addEventListener("input", zeichneTerminHinweis);
$("event-save-btn").addEventListener("click", saveEventModal);
$("event-cancel-btn").addEventListener("click", closeEventModal);
$("event-delete-btn").addEventListener("click", () => deleteEvent(editingEventId));
$("event-overlay").addEventListener("click", (e) => { if (e.target.id === "event-overlay") closeEventModal(); });

/* ================= ASSISTENT =================
   Eine zweite Tuer in dieselbe App: fragen, was ansteht, oder sagen, was
   passieren soll. Die Antworten kommen aus der Edge Function "assistent",
   die nur einen kleinen Datenausschnitt kennt. Gespeichert wird NIE aus dem
   Gespraech heraus – ein Vorschlag wird zur Karte mit Uebernehmen-Knopf,
   und Abo/Projekt oeffnen wie bei der Sprachnotiz das echte Formular.
   Der Verlauf lebt nur im Speicher dieser Sitzung: nichts existiert nur im
   Chat, die Tabs bleiben die Wahrheit. */

let assistentVerlauf = [];   // { rolle: "nutzer"|"assistent", text, vorschlag? }
let assistentWartet = false;

const VORSCHLAG_TITEL = { todo: "To-Do", note: "Notiz", subscription: "Abo", project: "Projekt" };

function vorschlagKarteHTML(v, index) {
  const zeilen = [];
  const zeile = (name, wert) => wert != null && zeilen.push(
    `<div class="vorschlag-feld"><span>${esc(name)}</span><span>${esc(String(wert))}</span></div>`);
  if (v.type === "todo") { zeile("Titel", v.title); zeile("Fällig", v.due_date && fmtDate(new Date(v.due_date + "T00:00:00"))); }
  if (v.type === "note") { zeile("Notiz", v.content || v.title); }
  if (v.type === "subscription") { zeile("Name", v.name); zeile("Preis", v.price != null ? fmt(v.price) : null); zeile("Kategorie", v.category); }
  if (v.type === "project") { zeile("Name", v.name || v.title); zeile("Art", v.kind); zeile("Auftragswert", v.order_value != null ? fmt(v.order_value) : null); zeile("Deadline", v.due_date && fmtDate(new Date(v.due_date + "T00:00:00"))); }
  const formular = v.type === "subscription" || v.type === "project";
  return `
  <div class="vorschlag-karte">
    <div class="vorschlag-kopf">${esc(VORSCHLAG_TITEL[v.type] || "Eintrag")}</div>
    ${zeilen.join("")}
    <button class="btn gold block" data-vorschlag="${index}">${formular ? "Im Formular öffnen" : "Übernehmen"}</button>
  </div>`;
}

function zeichneAssistent() {
  const box = $("assistent-thread");
  if (!assistentVerlauf.length) {
    box.innerHTML = `<div class="hint-text">Frag, was ansteht („Was ist heute wichtig?") oder sag, was passieren soll („Leg ein To-Do für morgen an").</div>`;
    return;
  }
  box.innerHTML = assistentVerlauf.map((m, i) =>
    `<div class="assistent-nachricht ${m.rolle}">${esc(m.text)}</div>` +
    (m.vorschlag ? vorschlagKarteHTML(m.vorschlag, i) : "")
  ).join("") + (assistentWartet ? `<div class="assistent-nachricht assistent tippt">…</div>` : "");
  box.querySelectorAll("[data-vorschlag]").forEach((b) =>
    b.addEventListener("click", () => uebernehmeVorschlag(Number(b.dataset.vorschlag))));
  box.scrollTop = box.scrollHeight;
}

async function sendeAnAssistent() {
  const eingabe = $("assistent-input");
  const text = eingabe.value.trim();
  if (!text || assistentWartet) return;
  eingabe.value = "";
  assistentVerlauf.push({ rolle: "nutzer", text });
  assistentWartet = true;
  zeichneAssistent();
  try {
    // Vorschlaege bleiben clientseitig – zum Server gehen nur Rolle und Text
    const { data, error } = await db.functions.invoke("assistent", {
      body: { nachrichten: assistentVerlauf.map((m) => ({ rolle: m.rolle, text: m.text })) }
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    assistentVerlauf.push({ rolle: "assistent", text: data.antwort || "…", vorschlag: data.vorschlag || null });
  } catch (err) {
    console.warn("Assistent:", err);
    assistentVerlauf.push({ rolle: "assistent", text: "Das hat gerade nicht geklappt – versuch es nochmal." });
  } finally {
    assistentWartet = false;
    zeichneAssistent();
    eingabe.focus();
  }
}

async function uebernehmeVorschlag(index) {
  const v = assistentVerlauf[index]?.vorschlag;
  if (!v) return;
  try {
    if (v.type === "todo") {
      const titel = v.title || v.content;
      if (!titel) { showToast("Kein Titel erkannt"); return; }
      const { data, error } = await db.from("todos")
        .insert({ user_id: user.id, title: titel, due_date: v.due_date || null }).select().single();
      if (error) throw error;
      ersetzeInListe(todos, data);
      renderAll();
      showToast("To-Do gespeichert");
    } else if (v.type === "note") {
      const inhalt = v.content || v.title;
      if (!inhalt) { showToast("Keine Notiz erkannt"); return; }
      const { data, error } = await db.from("notes")
        .insert({ user_id: user.id, content: inhalt }).select().single();
      if (error) throw error;
      ersetzeInListe(notes, data);
      renderAll();
      showToast("Notiz gespeichert");
    } else if (v.type === "subscription") {
      // Pflichtfelder, die aus einem Satz kaum sicher kommen -> echtes Formular
      schliesseAssistent();
      openModal(null);
      $("f-name").value = v.name || "";
      if (v.price != null) $("f-price").value = v.price;
      $("f-next").value = v.next_payment || toDateStr(todayMidnight());
      if ([1, 3, 6, 12].includes(v.cycle_months)) $("f-cycle").value = String(v.cycle_months);
      if (v.category) $("f-category").value = v.category;
      refreshPreview();
      refreshVatHint();
      return;
    } else if (v.type === "project") {
      schliesseAssistent();
      openProjectModal(null);
      $("project-f-name").value = v.name || v.title || "";
      if (v.kind) $("project-f-kind").value = v.kind;
      if (v.due_date) $("project-f-date").value = v.due_date;
      if (v.order_value != null) $("project-f-value").value = v.order_value;
      return;
    }
    // Nach dem Uebernehmen soll die Karte nicht erneut zum Speichern einladen
    assistentVerlauf[index].vorschlag = null;
    zeichneAssistent();
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  }
}

function oeffneAssistent() {
  zeichneAssistent();
  oeffneOverlay("assistent-overlay");
  setTimeout(() => $("assistent-input").focus(), 60);
}
function schliesseAssistent() { schliesseOverlay("assistent-overlay"); }

document.querySelectorAll(".sys-assistent").forEach((b) => b.addEventListener("click", oeffneAssistent));
$("assistent-close-btn").addEventListener("click", schliesseAssistent);
$("assistent-send-btn").addEventListener("click", sendeAnAssistent);
$("assistent-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendeAnAssistent(); });
$("assistent-overlay").addEventListener("click", (e) => { if (e.target.id === "assistent-overlay") schliesseAssistent(); });

/* ================= SUCHE =================
   Die #tags verbinden die Bausteine schon quer, aber nur, wenn man beim
   Schreiben an den Tag gedacht hat. Die Suche findet auch alles andere:
   denselben Aufbau wie die Tag-Ansicht, nur mit Freitext als Filter. */

// Klein schreiben und Umlaute/türkische Zeichen glattziehen, damit „Straße"
// auch bei „strasse" auftaucht und „İzmir" bei „izmir".
// Alle Ersetzungen außer ß sind 1:1 und lassen die Zeichenpositionen heil –
// nur so sitzen die Treffer-Markierungen unten an der richtigen Stelle.
// ß → ss ist die eine Ausnahme; in solchen Texten wird deshalb gefunden,
// aber nicht markiert (siehe Längenprüfung in hervorheben()).
function normalisiere(s) {
  return String(s ?? "")
    .replace(/İ/g, "I").replace(/ı/g, "i")
    .toLowerCase()
    .replace(/[äàâáã]/g, "a").replace(/[öòôóõ]/g, "o").replace(/[üùûú]/g, "u")
    .replace(/[éèêë]/g, "e").replace(/[íìîï]/g, "i")
    .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ç/g, "c").replace(/ñ/g, "n")
    .replace(/ß/g, "ss");
}

// Alle Begriffe müssen vorkommen (UND), egal in welchem der Felder
function passtAufBegriffe(begriffe, ...felder) {
  const heu = normalisiere(felder.filter(Boolean).join(" "));
  return begriffe.every((b) => heu.includes(b));
}

// Fundstellen im Text markieren. Erst schneiden, dann jedes Stück einzeln
// escapen – so kann aus dem Inhalt kein Markup entstehen.
function hervorheben(text, begriffe) {
  const roh = String(text ?? "");
  const norm = normalisiere(roh);
  // Sicherheitsnetz: verschöbe die Normalisierung doch einmal die Positionen,
  // lieber gar nicht markieren als an der falschen Stelle.
  if (norm.length !== roh.length) return esc(roh);
  const stellen = [];
  begriffe.forEach((b) => {
    let i = norm.indexOf(b);
    while (i !== -1 && b) { stellen.push([i, i + b.length]); i = norm.indexOf(b, i + b.length); }
  });
  if (!stellen.length) return esc(roh);
  stellen.sort((a, b) => a[0] - b[0]);
  // Überlappende Fundstellen verschmelzen, sonst verschachteln sich die <mark>
  const zusammen = [stellen[0]];
  for (const [von, bis] of stellen.slice(1)) {
    const letzte = zusammen[zusammen.length - 1];
    if (von <= letzte[1]) letzte[1] = Math.max(letzte[1], bis);
    else zusammen.push([von, bis]);
  }
  let aus = "", pos = 0;
  for (const [von, bis] of zusammen) {
    aus += esc(roh.slice(pos, von)) + "<mark>" + esc(roh.slice(von, bis)) + "</mark>";
    pos = bis;
  }
  return aus + esc(roh.slice(pos));
}

function sucheTreffer(eingabe) {
  const begriffe = normalisiere(eingabe).split(/\s+/).filter(Boolean);
  if (!begriffe.length) return null;
  return {
    begriffe,
    // Archivierte Abos und erledigte To-Dos bleiben drin – gerade danach sucht
    // man ja („was war das nochmal, das ich gekündigt hatte?").
    projekte: sortProjects(projects.filter((p) => passtAufBegriffe(begriffe, p.name, p.note, p.kind, p.status, p.link))),
    todos: sortTodos(todos.filter((t) => passtAufBegriffe(begriffe, t.title, t.description))),
    abos: subs.filter((s) => passtAufBegriffe(begriffe, s.name, s.note, s.category)),
    notizen: notes.filter((n) => passtAufBegriffe(begriffe, n.content)),
    module: uniModule.filter((m) => passtAufBegriffe(begriffe, m.name, m.ergebnis, m.note)),
    termine: events.filter((ev) => passtAufBegriffe(begriffe, ev.title, ev.note))
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0),
    google: googleEvents.filter((g) => passtAufBegriffe(begriffe, g.title))
  };
}

// Bei mehrzeiligen Notizen die Zeile zeigen, in der der Treffer steckt –
// sonst steht da die erste Zeile und man sieht nicht, warum es passt.
function notizAusschnitt(inhalt, begriffe) {
  const zeilen = String(inhalt || "").split("\n").filter((z) => z.trim());
  const treffer = zeilen.find((z) => passtAufBegriffe(begriffe, z)) || zeilen[0] || "";
  return treffer.length > 80 ? treffer.slice(0, 80) + "…" : treffer;
}

/* ---- Befehlsfeld: die Suche kann auch anlegen ----
   Ein Feld fuer beides – wer "netflix" tippt, sucht; wer "todo rechnung
   morgen" tippt, legt an. Mit Praefix (todo/notiz/abo/projekt) wird die
   Aktion gezielt, ohne Praefix stehen To-Do und Notiz als Angebot unter
   der Eingabe. Nichts passiert ohne Antippen der Aktionszeile. */

const BEFEHL_PRAEFIXE = {
  todo: "todo", "to-do": "todo", aufgabe: "todo",
  notiz: "note", note: "note",
  abo: "subscription",
  projekt: "project", kunde: "project",
  uni: "modul", modul: "modul",
};

function sucheAktionen(eingabe) {
  const roh = eingabe.trim();
  if (roh.length < 2) return [];
  const praefix = roh.match(/^(\S+)\s+(.+)$/);
  const art = praefix && BEFEHL_PRAEFIXE[praefix[1].toLowerCase()];
  if (art) return [{ art, text: praefix[2].trim() }];
  // Ohne Praefix: die zwei schnellen Wege anbieten – Abo/Projekt brauchen
  // ohnehin das Formular und lohnen keine eigene Zeile fuer jeden Suchbegriff.
  return [{ art: "todo", text: roh }, { art: "note", text: roh }];
}

const AKTION_NAME = { todo: "To-Do", note: "Notiz", subscription: "Abo", project: "Projekt", modul: "Modul" };

function aktionszeileHTML(a, index) {
  const erkannt = a.art === "todo" ? datumAusText(a.text) : null;
  const anzeige = erkannt?.datum && erkannt.titel ? erkannt.titel : a.text;
  const verb = a.art === "subscription" || a.art === "project" ? "im Formular öffnen" : "anlegen";
  // Der Datums-Chip sitzt im rechten Slot der Zeile – im Textbereich wuerde
  // ihn dessen Ellipse bei langen Titeln einfach abschneiden.
  const rechts = erkannt?.datum && erkannt.titel
    ? `<div class="tag-row-rechts"><span class="aktion-datum">${esc(dateBadge(erkannt.datum)[1])}</span></div>` : "";
  return `
  <div class="tag-row aktion" data-aktion="${index}">
    <div class="tag-row-symbol"><svg class="ic" viewBox="0 0 24 24"><use href="#i-plus"/></svg></div>
    <div class="tag-row-body">${esc(AKTION_NAME[a.art])} „${esc(anzeige)}“ ${verb}</div>
    ${rechts}
  </div>`;
}

async function fuehreAktionAus(a) {
  if (a.art === "todo") {
    const erkannt = datumAusText(a.text);
    const titel = erkannt.datum && erkannt.titel ? erkannt.titel : a.text;
    const { data, error } = await db.from("todos")
      .insert({ user_id: user.id, title: titel, due_date: erkannt.datum && erkannt.titel ? erkannt.datum : null })
      .select().single();
    if (error) { showToast("Fehler beim Speichern"); console.error(error); return; }
    ersetzeInListe(todos, data);
    renderAll();
    schliesseSuche();
    showToast("To-Do gespeichert");
  } else if (a.art === "note") {
    const { data, error } = await db.from("notes")
      .insert({ user_id: user.id, content: a.text }).select().single();
    if (error) { showToast("Fehler beim Speichern"); console.error(error); return; }
    ersetzeInListe(notes, data);
    renderAll();
    schliesseSuche();
    showToast("Notiz gespeichert");
  } else if (a.art === "subscription") {
    schliesseSuche();
    openModal(null);
    $("f-name").value = a.text;
    refreshPreview();
  } else if (a.art === "project") {
    schliesseSuche();
    openProjectModal(null);
    $("project-f-name").value = a.text;
  } else if (a.art === "modul") {
    // Wie die Schnelleingabe in der Uni-App: Datum im Satz wird zur Klausur
    const erkannt = zeitAusText(a.text);
    const name = erkannt.datum && erkannt.titel ? erkannt.titel : a.text;
    const { data, error } = await db.from("uni_module")
      .insert({ user_id: user.id, name, status: "laeuft",
                klausur_am: erkannt.datum, klausur_um: erkannt.datum ? erkannt.zeit : null })
      .select().single();
    if (error) { showToast("Fehler beim Speichern"); console.error(error); return; }
    data.klausur_um = data.klausur_um ? String(data.klausur_um).slice(0, 5) : null;
    uniModule.push(data);
    renderAll();
    schliesseSuche();
    showToast("Modul angelegt");
  }
}

function zeichneSuche() {
  const box = $("search-results");
  const eingabe = $("search-input").value;
  const aktionen = sucheAktionen(eingabe);
  const aktionenHTML = aktionen.length
    ? `<div class="tag-sec-head">Anlegen</div>` + aktionen.map(aktionszeileHTML).join("")
    : "";
  const bindeAktionen = () => box.querySelectorAll("[data-aktion]").forEach((el) =>
    el.addEventListener("click", () => fuehreAktionAus(aktionen[Number(el.dataset.aktion)])));

  const erg = sucheTreffer(eingabe);
  if (!erg) {
    box.innerHTML = `<div class="hint-text">Suchen – oder anlegen: „todo Rechnung morgen“, „notiz …“, „projekt …“.</div>`;
    return;
  }
  const b = erg.begriffe;
  const teile = [];

  if (erg.projekte.length) {
    teile.push(`<div class="tag-sec-head">Projekte</div>` + erg.projekte.map((p) =>
      tagRowHTML("projekt", p.id, svgIcon("folder"), hervorheben(p.name, b),
        `<span class="status-chip ${PROJECT_STATUS_CLASS[p.status] || "st-offen"}">${esc(p.status)}</span>`)
    ).join(""));
  }
  if (erg.todos.length) {
    teile.push(`<div class="tag-sec-head">To-Dos</div>` + erg.todos.map((t) =>
      tagRowHTML("todo", t.id, svgIcon("circle"),
        hervorheben(t.title, b) + (t.completed ? ` <span class="tag-dim">(erledigt)</span>` : ""),
        t.due_date ? `<span class="next ${dateBadge(t.due_date)[0]}">${dateBadge(t.due_date)[1]}</span>` : "")
    ).join(""));
  }
  if (erg.abos.length) {
    teile.push(`<div class="tag-sec-head">Abos</div>` + erg.abos.map((s) =>
      tagRowHTML("abo", s.id, svgIcon("card"),
        hervorheben(s.name, b) + (s.archived ? ` <span class="tag-dim">(archiviert)</span>` : ""),
        esc(`${fmt(ownShareMonthly(s))}/M`))
    ).join(""));
  }
  if (erg.notizen.length) {
    teile.push(`<div class="tag-sec-head">Notizen</div>` + erg.notizen.map((n) =>
      tagRowHTML("note", n.id, svgIcon("note"), hervorheben(notizAusschnitt(n.content, b), b),
        esc(kurzDatum(new Date(n.created_at))))
    ).join(""));
  }
  if (erg.module.length) {
    teile.push(`<div class="tag-sec-head">Uni</div>` + erg.module.map((m) =>
      tagRowHTML("modul", m.id, svgIcon("uni"), hervorheben(m.name, b),
        m.status === "laeuft"
          ? (m.klausur_am ? esc("Klausur " + kurzDatum(new Date(m.klausur_am + "T00:00:00"))) : "läuft")
          : esc(m.status + (m.ergebnis ? " · " + m.ergebnis : "")))).join(""));
  }
  if (erg.termine.length || erg.google.length) {
    // Eigene Termine sind anfassbar; Google-Termine sind Gaeste – anzeigen ja,
    // oeffnen nein, genau wie in der Agenda.
    teile.push(`<div class="tag-sec-head">Kalender</div>` +
      erg.termine.map((ev) =>
        tagRowHTML("termin", ev.id, svgIcon("calendar"), hervorheben(ev.title, b),
          esc(kurzDatum(new Date(ev.date + "T00:00:00")) + (ev.time ? " · " + ev.time : "")))).join("") +
      erg.google.map((g) =>
        `<div class="tag-row ohne-ziel">
          <div class="tag-row-symbol">${svgIcon("calendar")}</div>
          <div class="tag-row-body">${hervorheben(g.title, b)}<span class="gast-badge">Google</span></div>
          <div class="tag-row-rechts">${esc(kurzDatum(new Date(g.date + "T00:00:00")))}</div>
        </div>`).join(""));
  }

  // Aktionen stehen VOR den Treffern: wer tippt, um anzulegen, soll nicht
  // erst an einer Trefferliste vorbeiscrollen. Bei leeren Treffern ersetzt
  // die Aktionszeile den "Nichts gefunden"-Kasten – anlegen IST dann der Weg.
  box.innerHTML = aktionenHTML + (teile.join("") || (aktionen.length ? "" : leerHTML("Nichts gefunden.")));
  bindeAktionen();
  box.querySelectorAll(".tag-row:not(.ohne-ziel):not(.aktion)").forEach((el) =>
    el.addEventListener("click", () => { schliesseSuche(); oeffneEintrag(el.dataset.art, el.dataset.id); }));
}

function oeffneSuche() {
  $("search-input").value = "";
  zeichneSuche();
  oeffneOverlay("search-overlay");
  setTimeout(() => $("search-input").focus(), 60);
}
function schliesseSuche() { schliesseOverlay("search-overlay"); }

document.querySelectorAll(".sys-suche").forEach((b) => b.addEventListener("click", oeffneSuche));
$("search-close-btn").addEventListener("click", schliesseSuche);
$("search-input").addEventListener("input", zeichneSuche);
$("search-overlay").addEventListener("click", (e) => { if (e.target.id === "search-overlay") schliesseSuche(); });

/* ================= EINSTELLUNGEN ================= */
/* ---- Einstellungen: Google Kalender ---- */
function gcalFehlertext(code) {
  return {
    "ungueltige-url": "Adresse ungültig oder nicht mehr freigegeben",
    "netzwerk": "Kalender gerade nicht erreichbar",
  }[code] || "Kalender konnte nicht geladen werden";
}

function zeichneGcalEinstellungen() {
  const verknuepft = !!googleFeed;
  $("row-gcal-test").classList.toggle("hidden", !verknuepft);
  $("row-gcal-remove").classList.toggle("hidden", !verknuepft);
  $("gcal-status").textContent = !verknuepft
    ? "Zeigt deine Termine mit in der Übersicht"
    : googleFeed.last_status === "error"
      ? "Verknüpft – " + gcalFehlertext(googleFeed.last_error)
      : googleFeed.last_fetched_at
        ? `Verknüpft – zuletzt geprüft ${fmtDate(new Date(googleFeed.last_fetched_at))}`
        : "Verknüpft";
}

async function testeGcal() {
  const btn = $("set-gcal-test");
  btn.disabled = true;
  try {
    localStorage.removeItem(GCAL_CACHE_SCHLUESSEL);
    await loadGoogleEvents();
    await loadGoogleFeed();   // frische Statusfelder aus der DB
    zeichneGcalEinstellungen();
    renderAgenda();
    if (googleFeed?.last_status === "error") showToast(gcalFehlertext(googleFeed.last_error));
    else showToast(googleEvents.length === 1 ? "1 Termin gefunden" : `${googleEvents.length} Termine gefunden`);
  } finally {
    btn.disabled = false;
  }
}

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
    renderGeld();
  };
  zeichneGcalEinstellungen();
  $("set-gcal-save").onclick = async () => {
    const url = $("set-gcal-url").value.trim();
    if (!url) { showToast("Bitte die Adresse einfügen"); return; }
    // Grobe Formprüfung – ob die Adresse wirklich stimmt, zeigt der Test danach
    if (!/^https:\/\/calendar\.google\.com\/calendar\/ical\//.test(url)) {
      showToast("Das ist keine Google-Kalender-Adresse");
      return;
    }
    const { error } = await db.from("google_calendar_feeds")
      .upsert({ user_id: user.id, ical_url: url, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) { showToast("Fehler beim Speichern"); console.error(error); return; }
    // Die Adresse ist ein Geheimnis: nach dem Speichern nie wieder anzeigen,
    // nur der Status – dasselbe Prinzip wie beim PIN.
    $("set-gcal-url").value = "";
    localStorage.removeItem(GCAL_CACHE_SCHLUESSEL);
    await loadGoogleFeed();
    zeichneGcalEinstellungen();
    await testeGcal();
  };
  $("set-gcal-test").onclick = testeGcal;
  $("set-gcal-remove").onclick = async () => {
    if (!confirm("Google-Kalender-Verknüpfung entfernen?")) return;
    const { error } = await db.from("google_calendar_feeds").delete().eq("user_id", user.id);
    if (error) { showToast("Fehler beim Entfernen"); console.error(error); return; }
    googleFeed = null;
    googleEvents = [];
    localStorage.removeItem(GCAL_CACHE_SCHLUESSEL);
    zeichneGcalEinstellungen();
    renderAgenda();
    showToast("Entfernt");
  };

  zeichneSperreEinstellungen();
  $("set-pin").onclick = () => {
    if (!Tresor.eingerichtet()) { zeigeSchloss("neu"); return; }
    if (!confirm("Schloss entfernen? Die Anmeldung liegt danach wieder unverschlüsselt auf diesem Gerät.")) return;
    Tresor.aufheben();
    zeichneSperreEinstellungen();
    showToast("Schloss entfernt");
  };
  $("set-pin-aendern").onclick = () => zeigeSchloss("alt");
  $("set-faceid").onclick = faceIdUmschalten;
  $("set-sperrzeit").value = String(sperrzeit());
  $("set-sperrzeit").onchange = (e) => localStorage.setItem(SPERRZEIT_SCHLUESSEL, e.target.value);
  $("set-jetzt-sperren").onclick = jetztSperren;

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

/* ================= APP-NAVIGATION =================
   Kachel wird App: der Schirm zoomt per FLIP aus seiner Kachel auf und
   schrumpft beim Schliessen dorthin zurueck – der Kopf behaelt die Karte,
   wo man ist. Bei reduzierter Bewegung oder im Hintergrund-Tab wird hart
   geschaltet: ein eingefrorener Zoom saehe aus wie eine kaputte App. */

let flipTimer = null;

function ohneBewegung() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches || document.visibilityState === "hidden";
}

function kachelFuer(name) {
  return document.querySelector(`.kachel[data-app="${name}"]:not(.kachel-heute)`) ||
         document.querySelector(`.kachel[data-app="${name}"]`);
}

function oeffneAppScreen(name, quellKachel) {
  const schirm = $("app-" + name);
  if (!schirm || aktiveApp === name) return;
  aktiveApp = name;
  clearTimeout(flipTimer);
  document.querySelectorAll(".app-schirm").forEach((s2) => { if (s2 !== schirm) s2.classList.add("hidden"); });
  schirm.classList.remove("hidden");
  schirm.scrollTop = 0;
  if (name === "finanzen") renderStats();
  zeigeTabAn(schirm.querySelector(".app-inhalt"));
  const kachel = quellKachel || kachelFuer(name);
  if (ohneBewegung() || !kachel) return;
  const r = kachel.getBoundingClientRect();
  schirm.classList.remove("zoomt");
  schirm.style.transformOrigin = "top left";
  schirm.style.transform = `translate(${r.left}px, ${r.top}px) scale(${Math.max(r.width / innerWidth, 0.05)}, ${Math.max(r.height / innerHeight, 0.05)})`;
  schirm.style.opacity = "0.35";
  void schirm.offsetWidth;
  schirm.classList.add("zoomt");
  schirm.style.transform = "";
  schirm.style.opacity = "";
  const fertig = () => schirm.classList.remove("zoomt");
  schirm.addEventListener("transitionend", fertig, { once: true });
  flipTimer = setTimeout(fertig, 520);
}

function schliesseAppScreen() {
  if (!aktiveApp) return;
  const schirm = $("app-" + aktiveApp);
  const kachel = kachelFuer(aktiveApp);
  aktiveApp = null;
  renderHome();
  const zu = () => {
    schirm.classList.add("hidden");
    schirm.classList.remove("zoomt");
    schirm.style.transform = "";
    schirm.style.opacity = "";
  };
  if (ohneBewegung() || !kachel) { zu(); return; }
  clearTimeout(flipTimer);
  const r = kachel.getBoundingClientRect();
  schirm.classList.add("zoomt");
  schirm.style.transformOrigin = "top left";
  schirm.style.transform = `translate(${r.left}px, ${r.top}px) scale(${Math.max(r.width / innerWidth, 0.05)}, ${Math.max(r.height / innerHeight, 0.05)})`;
  schirm.style.opacity = "0";
  let erledigt = false;
  const fertig = () => { if (!erledigt) { erledigt = true; zu(); } };
  schirm.addEventListener("transitionend", fertig, { once: true });
  flipTimer = setTimeout(fertig, 520);
}

document.querySelectorAll(".kachel").forEach((k) =>
  k.addEventListener("click", () => oeffneAppScreen(k.dataset.app, k)));
document.querySelectorAll(".app-zurueck").forEach((b) =>
  b.addEventListener("click", schliesseAppScreen));

// Runterziehen am App-Kopf schliesst – der Kopf ist der Griff der App
document.querySelectorAll(".app-kopf").forEach((kopf) => {
  const schirm = kopf.closest(".app-schirm");
  let sy = 0, dy = 0;
  kopf.addEventListener("touchstart", (e) => { sy = e.touches[0].clientY; dy = 0; }, { passive: true });
  kopf.addEventListener("touchmove", (e) => {
    dy = Math.max(0, e.touches[0].clientY - sy);
    schirm.style.transform = dy ? `translateY(${dy}px)` : "";
    schirm.style.opacity = dy ? String(Math.max(0.45, 1 - dy / 420)) : "";
  }, { passive: true });
  kopf.addEventListener("touchend", () => {
    if (dy > 90) { schliesseAppScreen(); return; }
    schirm.classList.add("zoomt");
    schirm.style.transform = "";
    schirm.style.opacity = "";
    setTimeout(() => schirm.classList.remove("zoomt"), 460);
  });
});

// Der geoeffnete Bereich blendet einmal gestaffelt auf. Die Klasse fliegt
// danach wieder raus, damit spaeteres Neuzeichnen die Liste nicht erneut
// durchtanzen laesst – Bewegung markiert die Handlung, nicht den Zustand.
let tabAnimTimer = null;
function zeigeTabAn(sec) {
  if (!sec) return;
  clearTimeout(tabAnimTimer);
  document.querySelectorAll(".tab-in").forEach((el) => el.classList.remove("tab-in"));
  void sec.offsetWidth;
  sec.classList.add("tab-in");
  tabAnimTimer = setTimeout(() => sec.classList.remove("tab-in"), 700);
}

// Wer eine Liste komplett neu aufbaut, raeumt die Einzugs-Klasse vorher weg –
// sonst tanzt bei jedem Abhaken die ganze Liste erneut durch.
function stilleZeichnung() {
  clearTimeout(tabAnimTimer);
  document.querySelectorAll(".tab-in").forEach((el) => el.classList.remove("tab-in"));
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
  dateiHerunterladen(new Blob([lines.map(icsFold).join("\r\n")], { type: "text/calendar" }), "sarayos-zahltermine.ics");
  showToast("Kalender-Datei erstellt");
});

function dateiHerunterladen(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ================= DATENSICHERUNG =================
   Alles liegt in einem einzigen Supabase-Projekt. Je mehr hier zusammenläuft,
   desto teurer wäre ein Verlust – also ein Weg, die Inhalte herauszubekommen.
   Nur die geladenen Daten, kein Serveraufruf: was auf dem Schirm ist, ist auch
   in der Datei. */
$("backup-btn").addEventListener("click", () => {
  const sicherung = {
    app: "Saray OS",
    version: 2,
    erstellt_am: new Date().toISOString(),
    konto: user?.email || null,
    abos: subs,
    todos,
    notizen: notes,
    projekte: projects,
    termine: events,
    fitness: { tage: fitnessTage, uebungen: fitnessUebungen, saetze: fitnessSaetze },
    uni: uniModule,
    profil: profile
  };
  const tag = toDateStr(todayMidnight());
  dateiHerunterladen(new Blob([JSON.stringify(sicherung, null, 2)], { type: "application/json" }), `sarayos-sicherung-${tag}.json`);
  const anzahl = subs.length + todos.length + notes.length + projects.length;
  showToast(`${anzahl} Einträge gesichert`);
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
  const termine = events.filter((ev) => ev.date === toDateStr(todayMidnight()));
  if (!abos.length && !aufgaben.length && !deadlines.length && !termine.length) { if (force) showToast("Nichts fällig"); return; }
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
  if (termine.length) teile.push(termine.length === 1 ? "1 Termin" : `${termine.length} Termine`);
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(`Saray OS – ${teile.join(" · ")}`, {
      body: [
        ...abos.map((s) => `${customIcon(s) || "💳"} ${s.name}: ${fmt(bruttoPreis(s))} am ${fmtDate(new Date(s.next_payment + "T00:00:00"))}`),
        ...aufgaben.map((t) => `☐ ${t.title} (${dateBadge(t.due_date)[1]})`),
        ...deadlines.map((p) => `📁 ${p.name} (${dateBadge(p.due_date)[1]})`),
        ...termine.map((t) => `📅 ${t.title}${t.time ? ` · ${t.time}` : ""}`)
      ].join("\n"),
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png"
    });
  } catch (e) { console.warn(e); }
}

/* ================= SPRACHNOTIZ =================
   Aufnehmen, mitschreiben lassen, einordnen – aber nie stillschweigend
   speichern. Vor dem Schreiben kommt immer die Bestätigungskarte, sonst
   landet ein Hörfehler unbemerkt in der Datenbank. */

let aufnahmeRecorder = null;
let aufnahmeStuecke = [];
let aufnahmeTyp = "";
let aufnahmeStart = null;
let aufnahmeTimer = null;
let sprachTyp = "note";
let sprachDaten = null;

function sprachnotizMoeglich() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

async function starteAufnahme() {
  if (aufnahmeRecorder) { beendeAufnahme(); return; }   // erneutes Antippen beendet
  if (!sprachnotizMoeglich()) { showToast("Sprachnotizen gehen auf diesem Gerät nicht"); return; }

  let strom;
  try {
    strom = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast(err.name === "NotAllowedError" ? "Zugriff aufs Mikrofon abgelehnt" : "Mikrofon nicht verfügbar");
    return;
  }

  // Vor iOS 18.4 kann Safari nur mp4/AAC, danach auch webm/Opus.
  aufnahmeTyp = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]
    .find((t) => MediaRecorder.isTypeSupported(t)) || "";
  aufnahmeRecorder = new MediaRecorder(strom, aufnahmeTyp ? { mimeType: aufnahmeTyp } : undefined);
  aufnahmeStuecke = [];
  aufnahmeRecorder.ondataavailable = (e) => { if (e.data.size > 0) aufnahmeStuecke.push(e.data); };
  aufnahmeRecorder.onstop = () => {
    strom.getTracks().forEach((t) => t.stop());
    verarbeiteAufnahme();
  };
  aufnahmeRecorder.start();

  aufnahmeStart = Date.now();
  $("voice-btn").classList.add("laeuft");
  $("voice-bar").classList.remove("hidden");
  aufnahmeTimer = setInterval(zeichneAufnahmeZeit, 250);
  zeichneAufnahmeZeit();
}

function zeichneAufnahmeZeit() {
  const sek = Math.floor((Date.now() - aufnahmeStart) / 1000);
  $("voice-timer").textContent = `${Math.floor(sek / 60)}:${String(sek % 60).padStart(2, "0")}`;
}

function raeumeAufnahmeAuf() {
  clearInterval(aufnahmeTimer);
  $("voice-btn").classList.remove("laeuft");
  $("voice-bar").classList.add("hidden");
}

function beendeAufnahme() {
  if (!aufnahmeRecorder) return;
  aufnahmeRecorder.stop();       // onstop verarbeitet weiter
  aufnahmeRecorder = null;
  raeumeAufnahmeAuf();
}

function verwerfeAufnahme() {
  if (aufnahmeRecorder) {
    aufnahmeRecorder.onstop = null;   // nichts verarbeiten
    aufnahmeRecorder.stream?.getTracks().forEach((t) => t.stop());
    aufnahmeRecorder.stop();
    aufnahmeRecorder = null;
  }
  aufnahmeStuecke = [];
  raeumeAufnahmeAuf();
}

async function verarbeiteAufnahme() {
  const blob = new Blob(aufnahmeStuecke, { type: aufnahmeTyp || "audio/mp4" });
  aufnahmeStuecke = [];
  // Bekannter iOS-Fehler: die Aufnahme bleibt manchmal leer. Lieber klar
  // sagen, was zu tun ist, als still nichts passieren zu lassen.
  if (blob.size < 800) { showToast("Aufnahme leer – manchmal hilft ein Neustart des iPhones"); return; }

  showToast("Wird ausgewertet …");
  const form = new FormData();
  form.append("audio", blob, "aufnahme." + (aufnahmeTyp.includes("mp4") ? "m4a" : "webm"));
  try {
    const { data, error } = await db.functions.invoke("sprachnotiz", { body: form });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    if (!data || typeof data.text !== "string") throw new Error("Server war überlastet");
    if (!data.text) { showToast("Nichts verstanden – nochmal versuchen"); return; }
    oeffneSprachBestaetigung(data);
  } catch (err) {
    console.warn("Sprachnotiz:", err);
    showToast("Sprachnotiz fehlgeschlagen: " + (err.message || err));
  }
}

/* ---- Bestätigungskarte ---- */

function oeffneSprachBestaetigung(daten) {
  sprachDaten = daten;
  // Bei "unclear" nicht raten – die Notiz ist die harmloseste Ablage
  sprachTyp = ["todo", "note", "subscription", "project"].includes(daten.type) ? daten.type : "note";
  $("voice-transkript").textContent = `„${daten.text}"`;
  zeichneSprachTyp();
  oeffneOverlay("voice-overlay");
}

function zeichneSprachTyp() {
  $("voice-typ-row").querySelectorAll(".chip")
    .forEach((b) => b.classList.toggle("active", b.dataset.typ === sprachTyp));
  const el = $("voice-felder");
  if (sprachTyp === "todo") {
    el.innerHTML = `
      <div class="field"><label>Titel</label>
        <input type="text" id="voice-f-title" value="${esc(sprachDaten.title || sprachDaten.text)}"></div>
      <div class="field"><label>Fällig (optional)</label>
        <input type="date" id="voice-f-date" value="${sprachDaten.due_date || ""}"></div>`;
  } else if (sprachTyp === "note") {
    el.innerHTML = `
      <div class="field"><label>Notiz</label>
        <textarea id="voice-f-content" rows="4">${esc(sprachDaten.content || sprachDaten.text)}</textarea></div>`;
  } else {
    // Abo und Projekt haben Pflichtfelder, die aus einem Satz kaum sicher zu
    // erraten sind – dafür öffnet sich das gewohnte Formular, vorausgefüllt.
    el.innerHTML = `<div class="hint-text">Öffnet das ${sprachTyp === "subscription" ? "Abo" : "Projekt"}-Formular, schon ausgefüllt.</div>`;
  }
}

function schliesseSprachBestaetigung() {
  schliesseOverlay("voice-overlay");
  sprachDaten = null;
}

async function speichereSprachnotiz() {
  if (!sprachDaten) return;
  const btn = $("voice-save-btn");
  btn.disabled = true;
  try {
    if (sprachTyp === "todo") {
      const titel = $("voice-f-title").value.trim();
      if (!titel) { showToast("Bitte einen Titel eingeben"); return; }
      const { data, error } = await db.from("todos").insert({
        user_id: user.id, title: titel, due_date: $("voice-f-date").value || null
      }).select().single();
      if (error) throw error;
      ersetzeInListe(todos, data);
      schliesseSprachBestaetigung();
      renderAll();
      showToast("To-Do gespeichert");

    } else if (sprachTyp === "note") {
      const inhalt = $("voice-f-content").value.trim();
      if (!inhalt) { showToast("Notiz ist leer"); return; }
      const { data, error } = await db.from("notes")
        .insert({ user_id: user.id, content: inhalt }).select().single();
      if (error) throw error;
      ersetzeInListe(notes, data);
      schliesseSprachBestaetigung();
      renderAll();
      showToast("Notiz gespeichert");

    } else if (sprachTyp === "subscription") {
      const d = sprachDaten;
      schliesseSprachBestaetigung();
      openModal(null);
      $("f-name").value = d.name || "";
      if (d.price != null) $("f-price").value = d.price;
      // next_payment darf in der Datenbank nicht leer sein – heute als Platzhalter,
      // im Formular sieht Bedo es und korrigiert es bei Bedarf.
      $("f-next").value = d.next_payment || toDateStr(todayMidnight());
      if ([1, 3, 6, 12].includes(d.cycle_months)) $("f-cycle").value = String(d.cycle_months);
      if (d.category) $("f-category").value = d.category;
      refreshPreview();
      refreshVatHint();

    } else if (sprachTyp === "project") {
      const d = sprachDaten;
      schliesseSprachBestaetigung();
      openProjectModal(null);
      $("project-f-name").value = d.name || "";
      if (d.kind) $("project-f-kind").value = d.kind;
      if (d.due_date) $("project-f-date").value = d.due_date;
    }
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Speichern");
  } finally {
    btn.disabled = false;
  }
}

$("voice-btn").addEventListener("click", starteAufnahme);
$("voice-stop-btn").addEventListener("click", beendeAufnahme);
$("voice-cancel-rec-btn").addEventListener("click", verwerfeAufnahme);
$("voice-save-btn").addEventListener("click", speichereSprachnotiz);
$("voice-cancel-btn").addEventListener("click", schliesseSprachBestaetigung);
$("voice-overlay").addEventListener("click", (e) => { if (e.target.id === "voice-overlay") schliesseSprachBestaetigung(); });
$("voice-typ-row").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b || b.dataset.typ === sprachTyp) return;
  sprachTyp = b.dataset.typ;
  zeichneSprachTyp();
});

/* ================= SERVICE WORKER ================= */
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

/* ================= START ================= */
initAuth();
