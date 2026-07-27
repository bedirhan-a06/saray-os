# Saray OS – Serverteil

## Web Push

Erinnerungen kommen an, auch wenn die App geschlossen ist. Der tägliche
Rundlauf erinnert an fällige Abo-Zahlungen, offene To-Dos mit Datum und
Projekt-Deadlines (Überfälliges bleibt drin, bis es abgehakt bzw. der
Projektstatus auf „fertig" gestellt ist).

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
