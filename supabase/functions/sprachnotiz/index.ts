/**
 * Saray OS – Sprachnotiz.
 *
 * Nimmt eine Audioaufnahme entgegen, schreibt sie mit und ordnet den Text
 * einem Baustein zu (To-Do, Notiz, Abo, Projekt). Zwei Schritte, ein Aufruf:
 *   1. Transkription  – gpt-4o-mini-transcribe
 *   2. Einordnung     – gpt-4o-mini mit festem JSON-Schema
 *
 * Der Schluessel liegt im Vault und wird nur hier gelesen. Das Audio wird
 * nirgends gespeichert, nur durchgereicht.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const ZEITZONE = "Europe/Berlin";
// Muessen zu den Auswahlfeldern in der App passen, sonst kommt ein Wert
// zurueck, den das Formular nicht kennt.
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

// Die Signatur pruefte Supabase bereits (verify_jwt), hier nur noch auslesen.
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

let keyCache: string | null = null;
async function openaiKey(): Promise<string> {
  if (keyCache) return keyCache;
  const { data, error } = await admin.rpc("openai_key_get");
  if (error || !data) throw new Error("OpenAI-Schluessel nicht hinterlegt");
  keyCache = data as string;
  return keyCache;
}

/* ---------- Schritt 1: Mitschreiben ---------- */

async function transkribiere(audio: Blob, dateiname: string, key: string): Promise<string> {
  const form = new FormData();
  form.append("file", audio, dateiname);
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "de");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error("Transkription fehlgeschlagen: " + (await res.text()).slice(0, 300));
  const j = await res.json();
  return String(j.text || "").trim();
}

/* ---------- Schritt 2: Einordnen ---------- */

const SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["todo", "note", "subscription", "project", "unclear"] },
    title: { type: ["string", "null"], description: "Titel eines To-Dos" },
    due_date: { type: ["string", "null"], description: "YYYY-MM-DD, Faelligkeit eines To-Dos oder Projekts" },
    content: { type: ["string", "null"], description: "Inhalt einer Notiz" },
    name: { type: ["string", "null"], description: "Name eines Abos oder Projekts" },
    price: { type: ["number", "null"], description: "Preis eines Abos in Euro" },
    cycle_months: { type: ["integer", "null"], description: "Abrechnungszyklus in Monaten, meist 1 oder 12" },
    category: { type: ["string", "null"], enum: [...KATEGORIEN, null] },
    kind: { type: ["string", "null"], enum: [...PROJEKT_ARTEN, null] },
    next_payment: { type: ["string", "null"], description: "YYYY-MM-DD, naechster Zahltermin eines Abos" },
  },
  required: ["type", "title", "due_date", "content", "name", "price", "cycle_months", "category", "kind", "next_payment"],
  additionalProperties: false,
};

async function ordneEin(text: string, key: string) {
  const system =
    `Du ordnest eine kurze gesprochene Notiz einem Baustein einer persoenlichen App zu.\n` +
    `- "todo": eine Aufgabe, etwas zu erledigen. Feld: title, optional due_date.\n` +
    `- "note": ein Gedanke, eine Idee, etwas zum Merken. Feld: content.\n` +
    `- "subscription": ein Abo mit wiederkehrender Zahlung. Felder: name, price, cycle_months, category, next_payment.\n` +
    `- "project": ein Vorhaben oder Kundenauftrag. Felder: name, kind, optional due_date.\n` +
    `- "unclear": wenn du dir nicht sicher bist. Dann rate NICHT, sondern gib unclear zurueck.\n\n` +
    `Heute ist der ${heute()} (Europe/Berlin). Rechne relative Angaben wie "morgen", ` +
    `"naechsten Montag" oder "in zwei Wochen" in ein konkretes Datum um.\n` +
    `Felder, die zum gewaehlten Typ nicht passen, sind null.`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: system }, { role: "user", content: text }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "sprachnotiz", strict: true, schema: SCHEMA },
      },
    }),
  });
  if (!res.ok) throw new Error("Einordnung fehlgeschlagen: " + (await res.text()).slice(0, 300));
  const j = await res.json();
  return saubereFelder(JSON.parse(j.choices[0].message.content));
}

/* ---------- Nachputzen ----------
   Das Modell haengt gelegentlich Zeichen an einen Wert an (beobachtet:
   "2026-08-05}]}  {"). Was in eine typisierte Spalte laeuft, wird deshalb
   hier geprueft statt blind durchgereicht – eine kaputte Zahl oder ein
   kaputtes Datum soll gar nicht erst bis zur Bestaetigungskarte kommen. */

function sauberesDatum(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const treffer = v.match(/\d{4}-\d{2}-\d{2}/);
  if (!treffer) return null;
  const iso = treffer[0];
  const d = new Date(iso + "T00:00:00Z");
  // Faengt auch den 31. Februar ab: Date rechnet den stillschweigend um
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

function saubereFelder(roh: Record<string, unknown>) {
  const erlaubt = (v: unknown, liste: string[]) =>
    typeof v === "string" && liste.includes(v) ? v : null;
  const zyklus = saubereZahl(roh.cycle_months, 1, 120);
  return {
    type: erlaubt(roh.type, ["todo", "note", "subscription", "project"]) ?? "unclear",
    title: saubererText(roh.title, 200),
    due_date: sauberesDatum(roh.due_date),
    content: saubererText(roh.content, 4000),
    name: saubererText(roh.name, 200),
    price: saubereZahl(roh.price, 0, 1000000),
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
    if (!c.sub || typeof c.sub !== "string") {
      return new Response(JSON.stringify({ error: "nicht angemeldet" }), { status: 401, headers: kopfzeilen });
    }

    const form = await req.formData();
    const audio = form.get("audio");
    if (!(audio instanceof Blob) || audio.size === 0) {
      return new Response(JSON.stringify({ error: "keine Aufnahme" }), { status: 400, headers: kopfzeilen });
    }
    const dateiname = typeof (audio as File).name === "string" && (audio as File).name
      ? (audio as File).name
      : "aufnahme.mp4";

    const key = await openaiKey();
    const text = await transkribiere(audio, dateiname, key);
    // Nichts verstanden – gar nicht erst einordnen lassen
    if (!text) return new Response(JSON.stringify({ type: "unclear", text: "" }), { headers: kopfzeilen });

    const eingeordnet = await ordneEin(text, key);
    return new Response(JSON.stringify({ ...eingeordnet, text }), { headers: kopfzeilen });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: kopfzeilen });
  }
});
