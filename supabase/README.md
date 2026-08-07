# Saray OS – Serverteil

## Web Push

Erinnerungen kommen an, auch wenn die App geschlossen ist. Der tägliche
Rundlauf erinnert an fällige Abo-Zahlungen, offene To-Dos mit Datum,
Projekt-Deadlines (Überfälliges bleibt drin, bis es abgehakt bzw. der
Projektstatus auf „fertig" gestellt ist) und an Rechnungen, die seit mehr als
`RECHNUNG_FRIST_TAGE` (14) draußen sind und nicht bezahlt wurden.

### Bestandteile

| Wo | Was |
| --- | --- |
| `functions/push/index.ts` | Edge Function, drei Aktionen: `publicKey`, `test`, `send` |
| Tabelle `push_subscriptions` | ein Eintrag je angemeldetem Gerät, per RLS auf den Besitzer beschränkt |
| Vault `vapid_keys` | VAPID-Schlüsselpaar, erzeugt die Function beim ersten Aufruf selbst |
| Vault `push_cron_token` | Ausweis des Cron-Jobs, in der Datenbank per Zufall erzeugt |
| Cron-Job `sarayos-push-taeglich` | täglich 07:00 UTC, ruft `send` |

### Warum kein Service-Role-Schlüssel im Cron-Job

Der Job-Text steht im Klartext in `cron.job`. Statt des Service-Role-Schlüssels
weist sich der Job daher mit einem Zufallstoken aus dem Vault aus; im Job steht
nur der ohnehin öffentliche Publishable Key.

### Zeitpunkt

07:00 UTC sind 09:00 deutscher Sommerzeit bzw. 08:00 im Winter. Die Function
rechnet Fälligkeiten selbst in `Europe/Berlin`, damit „heute" nicht schon um
Mitternacht UTC umspringt. `last_notified_on` sorgt dafür, dass ein Gerät
höchstens eine Erinnerung pro Tag bekommt.

### Von Hand auslösen

```sql
select net.http_post(
  url := 'https://whooaauysrlxkmhalqfm.supabase.co/functions/v1/push',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer sb_publishable_yg_gPdvQYAxR8qEv0alR8Q_j0x0rfxI',
    'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_token')
  ),
  body := jsonb_build_object('action', 'send')
);
-- Antwort danach:
select status_code, content from net._http_response order by id desc limit 1;
```

### Wenn nichts ankommt

1. Steht ein Gerät in `push_subscriptions`? Sonst in der App auf 🔔 drücken.
   Am iPhone muss die App vorher auf dem Home-Bildschirm liegen (ab iOS 16.4).
2. Ist `reminders_enabled` im Profil an und liegt ein Abo oder To-Do innerhalb `lead_days`?
3. Rückgabe von `send` lesen: `entfernt` heißt, das Gerät hat sich abgemeldet –
   die App meldet es beim nächsten Start automatisch neu an.
4. Logs: Supabase Dashboard → Edge Functions → `push`.

iOS lässt Push-Anmeldungen still verfallen. Deshalb frischt die App die
Anmeldung bei jedem Start auf (`registerPush()` in `app.js`).

## Google Kalender

Die Übersicht zeigt Termine aus dem eigenen Google-Kalender mit an – read-only,
ohne OAuth. Grundlage ist die private iCal-Adresse, die Google pro Kalender
anbietet (Einstellungen → „Privatadresse im iCal-Format"). Der Nutzer trägt sie
einmal in den App-Einstellungen ein.

### Bestandteile

| Wo | Was |
| --- | --- |
| `functions/google-calendar/index.ts` | Edge Function, eine Aktion: `sync` |
| Tabelle `google_calendar_feeds` | eine Adresse je Nutzer, per RLS auf den Besitzer beschränkt |

### Warum über den Server

`calendar.google.com` erlaubt kein Cross-Origin-fetch aus dem Browser. Die
Function holt den Feed serverseitig, parst ihn mit `ical.js` (löst auch
Wiederholungsregeln auf) und liefert nur Titel, Datum und Uhrzeit der nächsten
30 Tage zurück – die private Adresse verlässt den Server nie. Kein Cron-Job:
die App ruft beim Start ab und hält das Ergebnis 15 Minuten im Client-Cache.

### Wenn keine Termine kommen

1. Einstellungen → Google Kalender → „Testen" drücken – die Meldung nennt den Grund.
2. „Adresse ungültig": Die Privatadresse wurde in Google zurückgesetzt oder
   falsch kopiert. Neue Adresse aus den Google-Kalender-Einstellungen holen.
3. Statusfelder in `google_calendar_feeds` (`last_status`, `last_error`) zeigen
   das Ergebnis des letzten Abrufs.
4. Logs: Supabase Dashboard → Edge Functions → `google-calendar`.

## Geld an Projekten

Die App kannte lange nur Geld, das rausgeht (Abos). Kundenprojekte tragen
jetzt die Gegenrichtung: `order_value` (Auftragswert) und `payment_status`
(`kein` → `Angebot raus` → `beauftragt` → `Rechnung raus` → `bezahlt`), dazu
`invoiced_on` und `paid_on`.

Das Websaray-Panel auf der Übersicht summiert daraus drei Zahlen: diesen Monat
eingegangen (nach `paid_on`), offen (alles mit `Rechnung raus`) und in Aussicht
(`Angebot raus` + `beauftragt`). Ohne einen einzigen Auftragswert bleibt das
Panel versteckt.

Die Datumsfelder erscheinen im Formular erst, wenn der Stand sie braucht, und
werden beim Umstellen mit dem heutigen Tag vorbelegt. Wird der Stand
zurückgesetzt, fallen sie wieder weg – sonst bliebe ein Bezahlt-Datum an einem
Projekt stehen, das gar nicht mehr als bezahlt gilt.

## Sprachnotiz

Aufnehmen, mitschreiben lassen, einordnen – und erst nach Bestätigung
speichern. Der Mikrofon-Knopf sitzt oben neben der Glocke.

### Bestandteile

| Wo | Was |
| --- | --- |
| `functions/sprachnotiz/index.ts` | Edge Function: Transkription + Einordnung in einem Aufruf |
| Vault `openai_api_key` | OpenAI-Schlüssel, nur über `openai_key_get()` lesbar |

### Ablauf

Der Browser nimmt per `MediaRecorder` auf und schickt den Ton an die Function.
Dort läuft er durch `gpt-4o-mini-transcribe`, der Text danach durch
`gpt-4o-mini` mit festem JSON-Schema, das ihn einem Baustein zuordnet
(To-Do, Notiz, Abo, Projekt – oder `unclear`, wenn unsicher). Das heutige
Datum steht im Prompt, damit „morgen" richtig gerechnet wird. Das Audio wird
nirgends gespeichert, nur durchgereicht.

To-Do und Notiz speichert die Bestätigungskarte direkt. Abo und Projekt haben
Pflichtfelder, die aus einem Satz kaum sicher zu erraten sind – dort öffnet
sich stattdessen das gewohnte Formular, schon ausgefüllt.

### Warum nachgeputzt wird

`saubereFelder()` prüft jeden Wert, bevor er zurückgeht. Grund: das Modell
hängt gelegentlich Zeichen an einen Wert an (beobachtet: `2026-08-05}]}  {`).
Was in eine typisierte Spalte läuft, wird deshalb geprüft statt blind
durchgereicht.

### Schlüssel austauschen

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'openai_api_key'),
  'sk-…neuer-schluessel…'
);
```
Danach die Function einmal neu deployen – sie hält den Schlüssel im Speicher.

### Wenn nichts ankommt

1. „Aufnahme leer": bekannter iOS-Fehler in installierten Web-Apps, hilft oft
   nur ein Neustart des iPhones.
2. „Server war überlastet": Edge Function lief ins Ressourcenlimit, meist bei
   mehreren Aufnahmen kurz hintereinander. Nochmal versuchen.
3. Logs: Supabase Dashboard → Edge Functions → `sprachnotiz`.
