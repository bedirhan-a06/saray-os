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

## Übersicht: Geld in einer Zeile

Einnahmen und Budget waren zwei dauerhaft offene Panels und brauchten zusammen
mehr Platz als die Agenda, für die der Tab eigentlich da ist. Jetzt steht dort
eine Zeile mit den zwei Zahlen, die täglich zählen (`geldZusammenfassung()`);
die Aufschlüsselung kommt auf Tippen und merkt sich ihren Zustand in
`localStorage` unter `saray.geld-offen`.

Von den Websaray-Zahlen zeigt die Zeile nur die eine, die gerade etwas will:
offene Rechnung vor eingegangenem Geld vor bloßer Aussicht. Ist eine Rechnung
länger als `RECHNUNG_MAHNUNG_TAGE` (14, dieselbe Frist wie im Push) draußen,
färbt sich die Zeile rot statt gelb.

Das Überfällig-Panel bleibt bewusst groß und oben: es verlangt eine Handlung
(bezahlt/gekündigt), keine Kenntnisnahme.

## Projekte nach Status

Die Projektliste gruppiert nach Status (`PROJEKT_GRUPPEN`: in Arbeit → offen →
wartet → fertig) statt flach zu listen. Der Status-Chip auf den Karten ist
dafür weggefallen — er stünde sonst zweimal da.

## Suche

Die Lupe in der Kopfzeile durchsucht Projekte, To-Dos, Abos, Notizen und die
Google-Termine – rein im Browser, alles liegt ohnehin schon geladen im Speicher.
Kein Serveraufruf, keine Volltext-Indizes in Postgres.

Aufbau und Darstellung teilt sie sich mit der Tag-Ansicht (`tagRowHTML`,
`oeffneEintrag`): dieselbe Frage, nur mit Freitext statt `#tag` als Filter.
Mehrere Wörter gelten als UND. Archivierte Abos und erledigte To-Dos sind
bewusst dabei – danach sucht man ja gerade.

`normalisiere()` zieht Groß-/Kleinschreibung, Umlaute und türkische Zeichen
glatt, damit „izmir" auch „İzmir" findet. Alle Ersetzungen sind 1:1, damit die
Zeichenpositionen erhalten bleiben und `hervorheben()` die Fundstellen an der
richtigen Stelle markiert. **Einzige Ausnahme ist ß → ss**: dort verschieben
sich die Positionen, deshalb prüft `hervorheben()` die Länge und markiert im
Zweifel gar nicht. „Straße" wird also gefunden, aber nicht hervorgehoben.

Nicht abgedeckt: „Muenchen" findet „München" nicht (Umlaute werden auf den
Grundbuchstaben abgebildet, nicht auf die ae/oe/ue-Schreibweise).

## Laden, Fehler, Datensicherung

Beim Start laufen die sechs Abrufe (Profil, Abos, To-Dos, Notizen, Projekte,
Kalender-Adresse) parallel statt nacheinander; nur die Google-Termine hängen am
Feed und kommen danach. Solange etwas unterwegs ist, stehen graue Platzhalter in
den Listen und die Kennzahlen oben treten zurück – sie sind noch nicht belastbar.

Scheitert ein Abruf, bleibt der bisherige Stand stehen und der Bereich meldet
„Konnte nicht geladen werden" mit einem Knopf, der nur diesen einen Bereich neu
holt (`ladeBereichNeu`). Wichtig, weil ein leerer Bereich sonst genauso aussieht
wie ein Konto ohne Daten – bei Auftragswerten und Rechnungen ein schlechter
Anfangsverdacht.

Nach dem Speichern wird die geänderte Zeile lokal ersetzt (`ersetzeInListe`),
statt die ganze Tabelle erneut zu holen: die Antwort liegt durch `.select()`
ohnehin schon vor.

Die Datensicherung in den Einstellungen legt Abos, To-Dos, Notizen, Projekte und
das Profil als eine JSON-Datei auf dem Gerät ab. Kein Serveraufruf – gesichert
wird, was geladen ist. Gedacht als Ausweg, falls das Supabase-Projekt einmal
nicht erreichbar ist; es ist **kein verschlüsseltes Backup**, die Datei liegt im
Klartext (auch die Notizen, die in der App hinter dem PIN liegen).

## Fitness-Coach (Etappe 2)

Jede Wiederholung wird eingetragen, der Coach rechnet — **regelbasiert, ohne
KI-Aufruf**, also ohne laufende Kosten. Drei Tabellen: `fitness_tage`
(Split-Tage), `fitness_uebungen` (Ziel-Sätze/Wdh, aktuelles Gewicht,
Schrittweite, Fehlversuche in Folge), `fitness_saetze` (Log: Datum, Satz-Nr,
Gewicht, Wdh). RLS wie überall.

Die Regeln: alle Ziel-Sätze voll geschafft → Gewicht **sofort** um die
Schrittweite hoch (der Coach-Moment direkt nach dem letzten Häkchen);
angefangen, aber nicht geschafft → Fehlversuch, gezählt beim „Training
beenden"; zweiter Fehlversuch in Folge → zwei Schritte runter, neuer Anlauf.
Übungen, die im Training gar nicht angefasst wurden, bekommen kein Urteil.

Eingerichtet wird in der App selbst (Push/Pull/Beine, OK/UK, Ganzkörper oder
leer), Übungen/Sätze/Gewichte jederzeit änderbar. „Dran" ist der Tag nach dem
zuletzt trainierten (Rotation). Die Home-Kachel füllt sich lime und atmet
langsam, wenn ein Training ansteht (letzter Besuch ≥ 2 Tage her) — die eine
bewusste ambiente Ausnahme vom Grundsatz „Bewegung nur bei Handlung".
Der Assistent kennt Übungen/Gewichte und die Trainingstage der letzten drei
Wochen (assistent v4).

## Etappe 1: Saray OS als OS

Die App ist kein Tab-Wechsler mehr, sondern ein OS: ein Home-Bildschirm mit
lebenden Kacheln (jede zeigt ihren Stand, bevor man tippt), jede Funktion eine
Vollbild-App, die per FLIP aus ihrer Kachel aufzoomt. Zurück per Chevron oder
Runterziehen am App-Kopf. Suche und Assistent sind System-Ebene: einmal in der
Home-Kopfzeile, einmal im Kopf jeder App.

Design „Schwarz & Signal": fast monochrom (#0a0a0a/#141414/#2a2a2a) plus eine
Signalfarbe (Lime #c8f04a). **Farbe = Dringlichkeit** — Signal leuchtet nur bei
überfällig/heute/zu lange offen. Die alte rot/gelb/grün-Ampel ist tot; Rot
bleibt für Fehler und Löschen. Die alten `--gold-*`-Variablen zeigen als
Aliasse auf das Signal, damit nicht jede Stelle angefasst werden musste.

Bewegung: Kachel-wird-App (FLIP), Lime-Sweep beim Abhaken (die Farbe verlässt
die Zeile), Wischgesten auf To-Do-Zeilen (rechts erledigt, links löscht),
rollende Zahlen, gestaffelter Home-Einzug. Bei `prefers-reduced-motion` oder
im Hintergrund-Tab wird hart geschaltet — ein eingefrorener Zoom sähe aus wie
eine kaputte App.

## Eigene Termine (Tabelle events)

`events`: title, date, time (nullable), note — RLS wie `todos`. Die
Kalender-App legt per Schnelleingabe an („Friseur Dienstag 14 Uhr" —
`zeitAusText()` versteht Tag UND Uhrzeit, mit Live-Hinweis vor dem Speichern);
bearbeiten/löschen im Termin-Modal. Eigene Termine laufen durch Agenda,
Monatsansicht, Suche, die lokale Tagesmitteilung, den täglichen Push
(functions/push, „N Termine") und den Assistent-Kontext (termine_7_tage).
Google-Termine bleiben read-only daneben, als „Google-Kalender" gekennzeichnet.

## Befehlsfeld und natürliches Eintragen

Die Suche kann auch anlegen: `todo Rechnung morgen`, `notiz …`, `abo …`,
`projekt …` (auch `kunde …`) zeigen eine Aktionszeile über den Treffern.
Ohne Präfix stehen To-Do und Notiz als Angebot dabei. To-Do/Notiz speichern
direkt beim Antippen, Abo/Projekt öffnen das Formular mit dem Namen
vorausgefüllt. Nichts passiert ohne Antippen der Zeile.

`datumAusText()` versteht Datumsangaben im Text — heute/morgen/übermorgen,
Wochentage, „in N Tagen/Wochen", `15.8.` (nächstes Vorkommen) und
`24.12.2026`. Bewusst **lokale Regeln statt KI-Aufruf**: kostet nichts und
ist für Datumsangaben zuverlässiger als ein Modell. Die To-Do-Schnelleingabe
zeigt live einen Chip mit dem verstandenen Datum; ein von Hand gewähltes
Datum im Feld gewinnt immer. Uhrzeiten bleiben absichtlich im Titel stehen —
To-Dos haben kein Zeitfeld, und ein stillschweigend verworfenes „14 Uhr"
wäre gelogen.

## Assistent

Eine zweite Tür in dieselbe App: fragen, was ansteht, oder sagen, was passieren
soll — als Gespräch statt über Formulare. Der Sprechblasen-Knopf sitzt links
neben der Lupe.

### Bestandteile

| Wo | Was |
| --- | --- |
| `functions/assistent/index.ts` | Edge Function: Kontext + Gespräch + Vorschlag in einem Aufruf |
| Vault `openai_api_key` | derselbe Schlüssel wie bei der Sprachnotiz, keine neue Ablage |

### Kostendisziplin (bewusst so gebaut)

- **Kleines Modell** (gpt-4o-mini) — die Intelligenz kommt aus den mitgegebenen
  Daten, nicht aus dem Modell.
- **Kleiner, gleichbleibend großer Kontext**: 7-Tage-Fenster, überfällige Abos,
  offene Rechnungen, Budget, Monatseinnahmen. Wächst der Datenbestand über
  Monate, wächst dieser Ausschnitt NICHT mit — die Kosten pro Nachricht bleiben
  stabil.
- **Verlauf gekappt** auf die letzten 8 Nachrichten (`VERLAUF_LIMIT`), sonst
  wird eine lange Sitzung mit jeder Runde teurer.
- **Kurze Antworten** (Stichpunkte) stehen im Prompt — Ausgabe-Tokens sind die
  teuren.
- **Nichts läuft im Hintergrund**: gerechnet wird nur, wenn eine Nachricht
  abgeschickt wird.

### Grenzen, die gelten

- Der Assistent **speichert nie selbst**. Ein erkannter Wunsch wird zum
  Vorschlag: To-Do/Notiz als Karte mit Übernehmen-Knopf, Abo/Projekt öffnen das
  echte Formular vorausgefüllt — dieselbe Disziplin wie bei der Sprachnotiz.
- Vorschlags-Felder laufen durch dieselbe Bereinigung wie dort
  (`saubererVorschlag`): Datum per Regex, Zahlen mit Grenzen, Enums per
  Allowliste. Geld am Projekt heißt `order_value`, beim Abo `price`.
- Fragen außerhalb von Bedos Leben/Websaray lenkt er zurück, statt zu
  plaudern — er ist kein ChatGPT-Ersatz.
- Der Verlauf lebt nur im Speicher der Sitzung; beim Abmelden ist er weg.
  Serverseitig wird nichts davon gespeichert.

### Wenn nichts kommt

1. Logs: Supabase Dashboard → Edge Functions → `assistent`.
2. „Das hat gerade nicht geklappt" in der Blase: meist Netz oder ein
   OpenAI-Aussetzer — einfach nochmal senden.

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
