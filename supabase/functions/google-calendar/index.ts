/**
 * Saray OS – Google-Kalender-Anzeige.
 *
 * Eine Aktion:
 *   sync – holt die vom Nutzer hinterlegte private iCal-Adresse, parst die
 *          Termine und liefert die nächsten 30 Tage als schlichte Liste.
 *
 * Der Umweg über den Server ist Pflicht: calendar.google.com erlaubt kein
 * Cross-Origin-fetch aus dem Browser. Die private Adresse verlässt den
 * Server nie – die App bekommt nur Titel, Datum und Uhrzeit.
 */
import ICAL from "npm:ical.js@2.2.1";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ZEITZONE = "Europe/Berlin";
const FENSTER_TAGE = 30;      // Puffer für die RRULE-Auflösung, Anzeige filtert enger
const MAX_VORKOMMEN = 500;    // Sicherheitsnetz gegen Wiederholungsregeln ohne Ende

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const kopfzeilen = {
  "Access-Control-Allow-Origin": "*",
  // x-client-info schickt supabase-js bei functions.invoke automatisch mit.
  // Fehlt es hier, scheitert schon der Preflight und der Aufruf kommt nie an.
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

/* ---------- Termine ---------- */

type Termin = { uid: string; title: string; date: string; time: string | null; allDay: boolean };

// Lokale deutsche Zeit, damit die App keine eigene Zeitzonen-Arithmetik braucht
// und "heute" nicht schon um Mitternacht UTC umspringt.
function alsBerlinTeile(d: Date): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZEITZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const teile = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${teile.year}-${teile.month}-${teile.day}`, time: `${teile.hour}:${teile.minute}` };
}

function expandiere(icsText: string): Termin[] {
  const comp = new ICAL.Component(ICAL.parse(icsText));
  const heute = new Date();
  heute.setHours(0, 0, 0, 0);
  const ende = new Date(heute);
  ende.setDate(ende.getDate() + FENSTER_TAGE);

  const out: Termin[] = [];
  const nimm = (event: InstanceType<typeof ICAL.Event>, start: Date, allDay: boolean) => {
    if (start < heute || start > ende) return;
    const { date, time } = alsBerlinTeile(start);
    out.push({
      uid: String(event.uid || ""),
      title: String(event.summary || "(ohne Titel)"),
      date,
      time: allDay ? null : time,
      allDay,
    });
  };

  for (const vevent of comp.getAllSubcomponents("vevent")) {
    try {
      const event = new ICAL.Event(vevent);
      const allDay = !!event.startDate?.isDate;
      if (!event.isRecurring()) {
        nimm(event, event.startDate.toJSDate(), allDay);
        continue;
      }
      // Wiederkehrend: ical.js loest RRULE inkl. UNTIL/COUNT/EXDATE selbst auf.
      // Iteration beginnt am DTSTART – bei alten Serienterminen (z. B. woechent-
      // liche Vorlesung seit 2024) liegen viele Vorkommen VOR dem Fenster, darum
      // wird erst ab Fensterbeginn eingesammelt und bei Fensterende abgebrochen.
      const iter = event.iterator();
      let n: unknown;
      let i = 0;
      while ((n = iter.next()) && i++ < MAX_VORKOMMEN) {
        const occ = event.getOccurrenceDetails(n);
        const start = occ.startDate.toJSDate();
        if (start > ende) break;
        nimm(event, start, allDay);
      }
    } catch (e) {
      // Ein einzelner kaputter Termin soll nicht den ganzen Kalender reissen
      console.warn("Termin uebersprungen:", e);
    }
  }

  out.sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")));
  return out;
}

/* ---------- Rundlauf ---------- */

async function sync(userId: string) {
  const { data: feed } = await admin
    .from("google_calendar_feeds")
    .select("ical_url")
    .eq("user_id", userId)
    .maybeSingle();
  if (!feed) return { events: [], error: null };

  const status = async (ok: boolean, fehler: string | null) => {
    await admin.from("google_calendar_feeds").update({
      last_fetched_at: new Date().toISOString(),
      last_status: ok ? "ok" : "error",
      last_error: fehler,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
  };

  let antwort: Response;
  try {
    antwort = await fetch(feed.ical_url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.warn("Kalender-Abruf:", e);
    await status(false, "netzwerk");
    return { events: [], error: "netzwerk" };
  }
  if (!antwort.ok) {
    await status(false, "ungueltige-url");
    return { events: [], error: "ungueltige-url" };
  }

  let events: Termin[];
  try {
    events = expandiere(await antwort.text());
  } catch (e) {
    console.warn("Kalender-Parsen:", e);
    await status(false, "ungueltige-url");
    return { events: [], error: "ungueltige-url" };
  }

  await status(true, null);
  return { events, error: null };
}

/* ---------- Einstieg ---------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: kopfzeilen });
  try {
    const c = claims(req);
    if (!c.sub || typeof c.sub !== "string") {
      return new Response(JSON.stringify({ error: "nicht angemeldet" }), { status: 401, headers: kopfzeilen });
    }
    const ergebnis = await sync(c.sub);
    return new Response(JSON.stringify(ergebnis), { headers: kopfzeilen });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: kopfzeilen });
  }
});
