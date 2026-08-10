/**
 * Saray OS – Web Push.
 *
 * Drei Aktionen:
 *   publicKey – liefert den oeffentlichen VAPID-Schluessel an die App
 *   test      – schickt dem Aufrufer sofort eine Probemitteilung
 *   send      – taeglicher Rundlauf, nur mit Service-Rolle (pg_cron)
 *
 * Das VAPID-Schluesselpaar wird beim ersten Aufruf erzeugt und im Supabase
 * Vault abgelegt. Der private Schluessel verlaesst den Server nie.
 */
import * as webpush from "jsr:@negrel/webpush@0.5.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Push-Dienste von Google/Apple/Mozilla nutzen diese Adresse, falls es
// Probleme mit dem Versand gibt. Muss laut RFC 8292 erreichbar sein.
const KONTAKT = "mailto:b.akguel01@gmail.com";
const ZEITZONE = "Europe/Berlin";
// Ab so vielen Tagen gilt eine offene Rechnung als erinnerungswuerdig
const RECHNUNG_FRIST_TAGE = 14;

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
    "authorization, content-type, apikey, x-client-info, x-supabase-api-version, x-cron-token",
  "Content-Type": "application/json",
};

/* ---------- Datum ---------- */
// Bewusst deutsche Zeit: sonst springt "heute" schon um 01:00 bzw. 02:00 Uhr.
function heute(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZEITZONE }).format(new Date());
}
function plusTage(iso: string, tage: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}
function alsDeutschesDatum(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
}
function alsEuro(n: unknown): string {
  return Number(n).toFixed(2).replace(".", ",") + " €";
}

/* ---------- VAPID ---------- */
let serverCache: webpush.ApplicationServer | null = null;
let publicKeyCache: string | null = null;

async function vapid() {
  if (serverCache && publicKeyCache) {
    return { server: serverCache, publicKey: publicKeyCache };
  }
  const { data: gespeichert, error } = await admin.rpc("push_vapid_get");
  if (error) throw new Error("Vault nicht lesbar: " + error.message);

  let exportiert;
  if (gespeichert) {
    exportiert = JSON.parse(gespeichert);
  } else {
    // Erster Aufruf ueberhaupt: Schluesselpaar erzeugen und einlagern.
    const frisch = await webpush.generateVapidKeys({ extractable: true });
    exportiert = await webpush.exportVapidKeys(frisch);
    const { error: schreibfehler } = await admin.rpc("push_vapid_set", {
      keys: JSON.stringify(exportiert),
    });
    if (schreibfehler) throw new Error("Vault nicht beschreibbar: " + schreibfehler.message);
  }

  const keys = await webpush.importVapidKeys(exportiert, { extractable: false });
  publicKeyCache = await webpush.exportApplicationServerKey(keys);
  serverCache = await webpush.ApplicationServer.new({
    contactInformation: KONTAKT,
    vapidKeys: keys,
  });
  return { server: serverCache, publicKey: publicKeyCache };
}

/* ---------- Versand ---------- */
type Geraet = { id: string; endpoint: string; p256dh: string; auth: string };

// Gibt true zurueck, wenn das Geraet weg ist und geloescht wurde.
async function sendeAn(
  server: webpush.ApplicationServer,
  g: Geraet,
  nutzlast: Record<string, unknown>,
): Promise<"ok" | "weg" | "fehler"> {
  try {
    await server
      .subscribe({ endpoint: g.endpoint, keys: { p256dh: g.p256dh, auth: g.auth } })
      .pushTextMessage(JSON.stringify(nutzlast), {});
    return "ok";
  } catch (e) {
    // 410 Gone bzw. 404: Abo existiert nicht mehr – Karteileiche entfernen.
    const weg = e instanceof webpush.PushMessageError &&
      (e.isGone() || e.response.status === 404);
    if (weg) {
      await admin.from("push_subscriptions").delete().eq("id", g.id);
      return "weg";
    }
    console.error("Push fehlgeschlagen:", g.endpoint.slice(0, 60), String(e));
    return "fehler";
  }
}

async function taeglicherRundlauf() {
  const { server } = await vapid();
  const tag = heute();

  const { data: profile, error } = await admin
    .from("profiles")
    .select("user_id, lead_days")
    .eq("reminders_enabled", true);
  if (error) throw new Error("Profile nicht lesbar: " + error.message);
  if (!profile?.length) return { tag, verschickt: 0, hinweis: "niemand hat Erinnerungen aktiv" };

  let verschickt = 0, entfernt = 0, fehler = 0, uebersprungen = 0;

  for (const p of profile) {
    const vorlauf = p.lead_days ?? 3;
    const { data: faellig } = await admin
      .from("subscriptions")
      .select("name, price, vat_percent, next_payment")
      .eq("user_id", p.user_id)
      .eq("archived", false)
      .gte("next_payment", tag)
      .lte("next_payment", plusTage(tag, vorlauf))
      .order("next_payment");

    // Offene To-Dos bis Ende des Vorlaufs. Keine Untergrenze: Überfälliges
    // bleibt in der Erinnerung, bis es abgehakt ist.
    const { data: aufgaben } = await admin
      .from("todos")
      .select("title, due_date")
      .eq("user_id", p.user_id)
      .eq("completed", false)
      .not("due_date", "is", null)
      .lte("due_date", plusTage(tag, vorlauf))
      .order("due_date");

    // Projekt-Deadlines im selben Fenster – bis der Status auf fertig springt
    const { data: deadlines } = await admin
      .from("projects")
      .select("name, due_date")
      .eq("user_id", p.user_id)
      .neq("status", "fertig")
      .not("due_date", "is", null)
      .lte("due_date", plusTage(tag, vorlauf))
      .order("due_date");

    // Rechnungen, die schon eine Weile draussen sind und nicht bezahlt wurden.
    // Feste Frist statt Einstellung: 14 Tage sind die uebliche Zahlungsfrist,
    // und eine weitere Schraube in den Einstellungen braucht niemand.
    const { data: rechnungen } = await admin
      .from("projects")
      .select("name, order_value, invoiced_on")
      .eq("user_id", p.user_id)
      .eq("payment_status", "Rechnung raus")
      .not("invoiced_on", "is", null)
      .lte("invoiced_on", plusTage(tag, -RECHNUNG_FRIST_TAGE))
      .order("invoiced_on");

    // Eigene Termine im Vorlauf-Fenster – ein Kalender, der nie erinnert,
    // waere nur eine Liste.
    const { data: termine } = await admin
      .from("events")
      .select("title, date, time")
      .eq("user_id", p.user_id)
      .gte("date", tag)
      .lte("date", plusTage(tag, vorlauf))
      .order("date");

    const abos = faellig ?? [];
    const offen = aufgaben ?? [];
    const projekte = deadlines ?? [];
    const ausstehend = rechnungen ?? [];
    const kalender = termine ?? [];
    if (!abos.length && !offen.length && !projekte.length && !ausstehend.length && !kalender.length) continue;

    const { data: geraete } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth, last_notified_on")
      .eq("user_id", p.user_id);
    if (!geraete?.length) continue;

    const teile: string[] = [];
    if (abos.length) teile.push(abos.length === 1 ? "1 Zahlung" : `${abos.length} Zahlungen`);
    if (offen.length) teile.push(offen.length === 1 ? "1 To-Do" : `${offen.length} To-Dos`);
    if (projekte.length) teile.push(projekte.length === 1 ? "1 Deadline" : `${projekte.length} Deadlines`);
    if (ausstehend.length) teile.push(ausstehend.length === 1 ? "1 offene Rechnung" : `${ausstehend.length} offene Rechnungen`);
    if (kalender.length) teile.push(kalender.length === 1 ? "1 Termin" : `${kalender.length} Termine`);
    const titel = teile.join(" · ");

    const wannText = (datum: string) =>
      datum < tag ? "überfällig" : datum === tag ? "heute" : `am ${alsDeutschesDatum(datum)}`;
    // Preis wie in der App: bei gesetztem MwSt-Satz gilt der Betrag als netto
    const brutto = (s: { price: unknown; vat_percent: unknown }) =>
      Number(s.price) * (1 + (Number(s.vat_percent) || 0) / 100);
    const text = [
      ...abos.map((s) => `${s.name}: ${alsEuro(brutto(s))} am ${alsDeutschesDatum(s.next_payment)}`),
      ...offen.map((t) => `☐ ${t.title} (${wannText(t.due_date)})`),
      ...projekte.map((pr) => `📁 ${pr.name} (${wannText(pr.due_date)})`),
      ...ausstehend.map((r) => {
        const tage = Math.round((Date.parse(tag + "T00:00:00Z") - Date.parse(r.invoiced_on + "T00:00:00Z")) / 864e5);
        const betrag = Number(r.order_value) > 0 ? ` ${alsEuro(r.order_value)}` : "";
        return `💶 ${r.name}${betrag} – Rechnung seit ${tage} Tagen offen`;
      }),
      ...kalender.map((t) =>
        `📅 ${t.title}${t.time ? ` · ${String(t.time).slice(0, 5)}` : ""} (${t.date === tag ? "heute" : "am " + alsDeutschesDatum(t.date)})`),
    ].join("\n");

    for (const g of geraete) {
      // Pro Geraet hoechstens eine Erinnerung am Tag
      if (g.last_notified_on === tag) { uebersprungen++; continue; }
      const stand = await sendeAn(server, g, { title: "Saray OS – " + titel, body: text });
      if (stand === "ok") {
        await admin.from("push_subscriptions").update({ last_notified_on: tag }).eq("id", g.id);
        verschickt++;
      } else if (stand === "weg") entfernt++;
      else fehler++;
    }
  }
  return { tag, verschickt, entfernt, fehler, uebersprungen };
}

async function probeAn(userId: string) {
  const { server } = await vapid();
  const { data: geraete } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId);
  if (!geraete?.length) return { verschickt: 0, hinweis: "kein Geraet angemeldet" };

  let verschickt = 0, entfernt = 0, fehler = 0;
  for (const g of geraete) {
    const stand = await sendeAn(server, g, {
      title: "Saray OS – Test",
      body: "Wenn du das liest, kommen Mitteilungen bei dir an. 🎉",
    });
    if (stand === "ok") verschickt++;
    else if (stand === "weg") entfernt++;
    else fehler++;
  }
  return { verschickt, entfernt, fehler };
}

/* ---------- Anfragen ---------- */

// Der Cron-Job weist sich mit einem Token aus dem Vault aus, nicht mit dem
// Service-Role-Schluessel – der muesste sonst im Job-Text der Datenbank stehen.
async function cronTokenStimmt(req: Request): Promise<boolean> {
  const mitgeschickt = req.headers.get("x-cron-token");
  if (!mitgeschickt) return false;
  const { data: erwartet } = await admin.rpc("push_cron_token_get");
  if (!erwartet || typeof erwartet !== "string") return false;
  if (mitgeschickt.length !== erwartet.length) return false;
  // Zeichenweise ohne fruehen Abbruch, damit die Laufzeit nichts verraet
  let abweichung = 0;
  for (let i = 0; i < erwartet.length; i++) {
    abweichung |= mitgeschickt.charCodeAt(i) ^ erwartet.charCodeAt(i);
  }
  return abweichung === 0;
}

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: kopfzeilen });

  let rumpf: Record<string, unknown> = {};
  try { rumpf = await req.json(); } catch { /* leerer Rumpf ist erlaubt */ }
  const aktion = (rumpf.action as string) ?? "send";
  const c = claims(req);

  try {
    if (aktion === "publicKey") {
      const { publicKey } = await vapid();
      return new Response(JSON.stringify({ publicKey }), { headers: kopfzeilen });
    }

    if (aktion === "test") {
      const userId = c.sub as string | undefined;
      if (!userId) {
        return new Response(JSON.stringify({ error: "nicht angemeldet" }), { status: 401, headers: kopfzeilen });
      }
      return new Response(JSON.stringify(await probeAn(userId)), { headers: kopfzeilen });
    }

    if (aktion === "send") {
      // Ohne diese Pruefung koennte jeder angemeldete Nutzer den Rundlauf
      // fuer alle ausloesen – der gehoert allein dem Cron-Job.
      if (c.role !== "service_role" && !(await cronTokenStimmt(req))) {
        return new Response(JSON.stringify({ error: "nicht erlaubt" }), { status: 403, headers: kopfzeilen });
      }
      return new Response(JSON.stringify(await taeglicherRundlauf()), { headers: kopfzeilen });
    }

    return new Response(JSON.stringify({ error: "unbekannte Aktion" }), { status: 400, headers: kopfzeilen });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: kopfzeilen });
  }
});
