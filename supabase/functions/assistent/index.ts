/**
 * Saray OS – Assistent.
 *
 * Eine zweite Tuer in dieselbe App: ein Gespraech, das Bedos eigene Daten
 * kennt (Agenda-Fenster, offene Rechnungen, Budget) und auf Wunsch einen
 * Vorschlag macht – gespeichert wird nie hier, nur die App zeigt danach die
 * gewohnte Bestaetigungskarte. Bewusst kleines Modell (gpt-4o-mini) und ein
 * kleiner, gleichbleibend grosser Datenausschnitt statt der ganzen Historie:
 * die Kosten sollen nicht mit den Daten mitwachsen.
 *
 * Kein eigenes Secret – nutzt denselben Vault-Schluessel wie die Sprachnotiz.
 * Kein Verlauf wird serverseitig gespeichert; der Client schickt ihn mit.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const ZEITZONE = "Europe/Berlin";
const RECHNUNG_FRIST_TAGE = 14;
// Mehr Verlauf heisst mehr Tokens bei JEDER Nachricht, nicht nur einmal –
// eine lange Sitzung soll nicht mit jeder Runde teurer werden.
const VERLAUF_LIMIT = 8;
const KATEGORIEN = ["Streaming", "Musik", "Software", "Gaming", "Cloud", "Sonstige"];
const PROJEKT_ARTEN = ["Kunde", "Eigenes", "Sonstiges"];

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const kopfzeilen = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
  "Content-Type": "application/json",
};

function claims(req: Request): Record<string, unknown> {
  const roh = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const teil = roh.split(".")[1];
  if (!teil) return {};
  try {
    const b64 = teil.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
  } catch {
    return {};
  }
}

function heute(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZEITZONE }).format(new Date());
}
function plusTage(iso: string, tage: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}
function tageZwischen(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
}
function alsEuro(n: unknown): string {
  return Number(n).toFixed(2).replace(".", ",") + " €";
}

let keyCache: string | null = null;
async function openaiKey(): Promise<string> {
  if (keyCache) return keyCache;
  const { data, error } = await admin.rpc("openai_key_get");
  if (error || !data) throw new Error("OpenAI-Schluessel nicht hinterlegt");
  keyCache = data as string;
  return keyCache;
}

/* ---------- Kontext: klein und gleichbleibend gross ----------
   Kein Datenabzug der ganzen App – nur das 7-Tage-Fenster, offene
   Rechnungen und Budget. Waechst Bedos Datenmenge über Monate, waechst
   dieser Ausschnitt NICHT mit; die Kosten pro Nachricht bleiben stabil. */

async function kontext(userId: string) {
  const tag = heute();
  const grenze = plusTage(tag, 7);

  const [{ data: subs }, { data: todos }, { data: projects }, { data: profile }, { data: evts }, { data: fitU }, { data: fitS }, { data: module }] = await Promise.all([
    admin.from("subscriptions").select("name, price, vat_percent, next_payment")
      .eq("user_id", userId).eq("archived", false),
    admin.from("todos").select("title, due_date")
      .eq("user_id", userId).eq("completed", false).not("due_date", "is", null).lte("due_date", grenze),
    admin.from("projects").select("name, status, due_date, order_value, payment_status, invoiced_on, paid_on")
      .eq("user_id", userId),
    admin.from("profiles").select("display_name, monthly_budget").eq("user_id", userId).maybeSingle(),
    admin.from("events").select("title, date, time")
      .eq("user_id", userId).gte("date", tag).lte("date", grenze).order("date"),
    admin.from("fitness_uebungen").select("name, gewicht, ziel_saetze, ziel_wdh")
      .eq("user_id", userId),
    admin.from("fitness_saetze").select("datum")
      .eq("user_id", userId).gte("datum", plusTage(tag, -21)),
    admin.from("uni_module").select("name, status, klausur_am, klausur_um, ergebnis")
      .eq("user_id", userId),
  ]);

  const brutto = (s: { price: unknown; vat_percent: unknown }) =>
    Number(s.price) * (1 + (Number(s.vat_percent) || 0) / 100);

  const ueberfaelligeAbos = (subs ?? [])
    .filter((s) => s.next_payment < tag)
    .map((s) => ({ name: s.name, betrag: alsEuro(brutto(s)), seit_tagen: tageZwischen(s.next_payment, tag) }));
  const kommendeAbos = (subs ?? [])
    .filter((s) => s.next_payment >= tag && s.next_payment <= grenze)
    .map((s) => ({ name: s.name, betrag: alsEuro(brutto(s)), am: s.next_payment }));
  const offeneTodos = (todos ?? []).map((t) => ({
    titel: t.title,
    faellig: t.due_date < tag ? "überfällig" : t.due_date === tag ? "heute" : t.due_date,
  }));
  const deadlines = (projects ?? [])
    .filter((p) => p.status !== "fertig" && p.due_date && p.due_date <= grenze)
    .map((p) => ({ name: p.name, status: p.status, faellig: p.due_date! < tag ? "überfällig" : p.due_date }));
  const offeneRechnungen = (projects ?? [])
    .filter((p) => p.payment_status === "Rechnung raus" && p.invoiced_on && p.invoiced_on <= plusTage(tag, -RECHNUNG_FRIST_TAGE))
    .map((p) => ({ name: p.name, betrag: p.order_value ? alsEuro(p.order_value) : null, seit_tagen: tageZwischen(p.invoiced_on!, tag) }));
  const monatsStart = tag.slice(0, 7) + "-01";
  const einnahmenDiesenMonat = (projects ?? [])
    .filter((p) => p.payment_status === "bezahlt" && p.paid_on && p.paid_on >= monatsStart)
    .reduce((s, p) => s + (Number(p.order_value) || 0), 0);

  return {
    heute: tag,
    name: profile?.display_name || null,
    monatsbudget: profile?.monthly_budget ? alsEuro(profile.monthly_budget) : null,
    ueberfaellige_abos: ueberfaelligeAbos,
    kommende_abos_7_tage: kommendeAbos,
    offene_todos_7_tage: offeneTodos,
    projekt_deadlines_7_tage: deadlines,
    offene_rechnungen: offeneRechnungen,
    einnahmen_diesen_monat: alsEuro(einnahmenDiesenMonat),
    termine_7_tage: (evts ?? []).map((ev) => ({
      titel: ev.title, am: ev.date, um: ev.time ? String(ev.time).slice(0, 5) : null,
    })),
    fitness: {
      uebungen: (fitU ?? []).map((u) => ({
        name: u.name, gewicht: u.gewicht == null ? null : Number(u.gewicht),
        ziel: `${u.ziel_saetze}x${u.ziel_wdh}`,
      })),
      trainingstage_letzte_3_wochen: [...new Set((fitS ?? []).map((x) => x.datum))].sort(),
    },
    uni_module: (module ?? []).map((m) => ({
      name: m.name, status: m.status, klausur_am: m.klausur_am,
      klausur_um: m.klausur_um ? String(m.klausur_um).slice(0, 5) : null, ergebnis: m.ergebnis,
    })),
  };
}

/* ---------- Gespraech ---------- */

const SCHEMA = {
  type: "object",
  properties: {
    antwort: { type: "string", description: "Kurze Antwort in Stichpunkten, Deutsch, kein Fliesstext" },
    vorschlag: {
      type: ["object", "null"],
      description: "Nur setzen, wenn Bedo erkennbar etwas anlegen oder aendern will",
      properties: {
        type: { type: "string", enum: ["todo", "note", "subscription", "project"] },
        title: { type: ["string", "null"] },
        due_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
        content: { type: ["string", "null"] },
        name: { type: ["string", "null"] },
        price: { type: ["number", "null"], description: "Preis eines Abos in Euro" },
        order_value: { type: ["number", "null"], description: "Auftragswert eines Projekts in Euro" },
        cycle_months: { type: ["integer", "null"] },
        category: { type: ["string", "null"], enum: [...KATEGORIEN, null] },
        kind: { type: ["string", "null"], enum: [...PROJEKT_ARTEN, null] },
        next_payment: { type: ["string", "null"], description: "YYYY-MM-DD" },
      },
      required: ["type", "title", "due_date", "content", "name", "price", "order_value", "cycle_months", "category", "kind", "next_payment"],
      additionalProperties: false,
    },
  },
  required: ["antwort", "vorschlag"],
  additionalProperties: false,
};

type Nachricht = { rolle: "nutzer" | "assistent"; text: string };

async function antworte(verlauf: Nachricht[], daten: Record<string, unknown>, key: string) {
  const system =
    `Du bist der Assistent von Saray OS, Bedos persönlichem Life-OS für Abos, To-Dos, ` +
    `Notizen, Websaray-Projekte, seine Uni-Module samt Klausuren und sein Krafttraining. Du kennst nur die Daten unten, sonst nichts über Bedo.\n\n` +
    `Antworte kurz, in Stichpunkten, kein Geschwafel. Geht die Frage nicht um Bedos Leben ` +
    `oder Websaray, sag das ehrlich und lenk zurück, statt allgemein zu plaudern – du bist kein ` +
    `Ersatz für einen normalen Chat-Assistenten, sondern der Assistent für genau diese App.\n\n` +
    `Will Bedo erkennbar etwas anlegen oder ändern (To-Do, Notiz, Abo, Projekt), fülle "vorschlag" ` +
    `mit den erkannten Feldern – sonst ist vorschlag null. Du speicherst NIE selbst; die App zeigt ` +
    `Bedo danach eine Bestätigung. Felder, die zum Typ nicht passen, sind null. Geld an einem ` +
    `Projekt gehört in "order_value", der Preis eines Abos in "price". Rechne relative ` +
    `Angaben ("morgen", "in zwei Wochen") in ein konkretes Datum um.\n\n` +
    `Daten:\n${JSON.stringify(daten)}`;

  const messages = [
    { role: "system", content: system },
    ...verlauf.map((m) => ({ role: m.rolle === "nutzer" ? "user" : "assistant", content: m.text })),
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      response_format: { type: "json_schema", json_schema: { name: "assistent", strict: true, schema: SCHEMA } },
    }),
  });
  if (!res.ok) throw new Error("Gespräch fehlgeschlagen: " + (await res.text()).slice(0, 300));
  const j = await res.json();
  return JSON.parse(j.choices[0].message.content);
}

/* ---------- Nachputzen ----------
   Dieselbe Disziplin wie bei der Sprachnotiz: was in eine typisierte Spalte
   laufen koennte, wird geprueft statt blind durchgereicht. */

function sauberesDatum(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const treffer = v.match(/\d{4}-\d{2}-\d{2}/);
  if (!treffer) return null;
  const iso = treffer[0];
  const d = new Date(iso + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
function saubereZahl(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function saubererText(v: unknown, maxLaenge: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, maxLaenge) : null;
}

function saubererVorschlag(roh: Record<string, unknown> | null) {
  if (!roh) return null;
  const erlaubt = (v: unknown, liste: string[]) => (typeof v === "string" && liste.includes(v) ? v : null);
  const typ = erlaubt(roh.type, ["todo", "note", "subscription", "project"]);
  if (!typ) return null; // ein Vorschlag ohne gueltigen Typ ist keiner
  const zyklus = saubereZahl(roh.cycle_months, 1, 120);
  return {
    type: typ,
    title: saubererText(roh.title, 200),
    due_date: sauberesDatum(roh.due_date),
    content: saubererText(roh.content, 4000),
    name: saubererText(roh.name, 200),
    price: saubereZahl(roh.price, 0, 1000000),
    order_value: saubereZahl(roh.order_value, 0, 10000000),
    cycle_months: zyklus === null ? null : Math.round(zyklus),
    category: erlaubt(roh.category, KATEGORIEN),
    kind: erlaubt(roh.kind, PROJEKT_ARTEN),
    next_payment: sauberesDatum(roh.next_payment),
  };
}

/* ---------- Einstieg ---------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: kopfzeilen });
  try {
    const c = claims(req);
    const userId = c.sub as string | undefined;
    if (!userId) {
      return new Response(JSON.stringify({ error: "nicht angemeldet" }), { status: 401, headers: kopfzeilen });
    }

    const rumpf = await req.json().catch(() => ({}));
    const roherVerlauf = Array.isArray(rumpf.nachrichten) ? rumpf.nachrichten : [];
    const verlauf: Nachricht[] = roherVerlauf
      .filter((m: unknown): m is Nachricht =>
        !!m && typeof m === "object" && (m as Nachricht).rolle && typeof (m as Nachricht).text === "string")
      .slice(-VERLAUF_LIMIT);
    if (!verlauf.length || verlauf[verlauf.length - 1].rolle !== "nutzer") {
      return new Response(JSON.stringify({ error: "keine Nachricht" }), { status: 400, headers: kopfzeilen });
    }

    const key = await openaiKey();
    const daten = await kontext(userId);
    const ergebnis = await antworte(verlauf, daten, key);

    return new Response(JSON.stringify({
      antwort: saubererText(ergebnis.antwort, 2000) || "…",
      vorschlag: saubererVorschlag(ergebnis.vorschlag),
    }), { headers: kopfzeilen });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: kopfzeilen });
  }
});
