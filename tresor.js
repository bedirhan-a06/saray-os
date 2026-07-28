/* ================= Saray OS – Tresor =================
   Schloss über der Anmeldung: PIN und Face ID.

   Der Kern ist bewusst nicht „Bildschirm davor", sondern echte Verschlüsselung.
   Die Supabase-Sitzung (Access- und Refresh-Token) liegt NICHT mehr im Klartext
   in localStorage, sondern nur als Chiffrat. Ohne PIN bzw. Face ID ist sie auch
   mit Entwicklerwerkzeugen nicht lesbar.

   Aufbau:
     Hauptschlüssel (HS)  – 256-Bit-AES-Schlüssel, rein zufällig, nur im Speicher.
                            Verschlüsselt die Sitzung.
     PIN-Hülle            – HS, verschlüsselt mit einem aus dem PIN abgeleiteten
                            Schlüssel (PBKDF2-SHA-256, gesalzen).
     Face-ID-Hülle        – HS, verschlüsselt mit einem Geheimnis, das der
                            Passkey über die WebAuthn-PRF-Erweiterung liefert.
                            Optional; ohne PRF-Unterstützung gibt es nur den PIN.

   Der HS selbst wechselt nie. PIN ändern heißt: nur die Hülle neu schreiben –
   die verschlüsselte Sitzung bleibt, wie sie ist.

   Grenze, die ehrlich benannt gehört: ein sechsstelliger PIN hat rund 20 Bit
   Entropie. Die Schlüsselableitung macht Durchprobieren teuer, aber nicht
   unmöglich, wenn jemand das Chiffrat abzieht. Dagegen steht die Sperre nach
   zehn Fehlversuchen – die deckt den realistischen Fall ab (fremdes Handy in
   der Hand), nicht den Angreifer mit Rechenzentrum.
*/
"use strict";

const Tresor = (() => {
  const SCHLUESSEL = "saray.tresor";
  const RUNDEN = 600000;          // OWASP-Empfehlung für PBKDF2-SHA-256
  const MAX_FEHLVERSUCHE = 10;
  const PIN_LAENGE = 6;

  let hs = null;                  // CryptoKey – nur im Arbeitsspeicher, nie auf Platte
  let sitzung = {};               // Klartext-Ablage, aus der Supabase liest

  /* ---- Kleinkram ---- */

  // In Blöcken, weil String.fromCharCode(...) bei großen Puffern den Stapel sprengt
  function nachB64(puffer) {
    const bytes = new Uint8Array(puffer);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function ausB64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
  function zufall(n) { return crypto.getRandomValues(new Uint8Array(n)); }

  // Bewusst ohne Zwischenspeicher: liegt die App in zwei Tabs offen, würde ein
  // veralteter Stand die Änderungen des anderen Tabs überschreiben – im
  // schlimmsten Fall einen hochgezählten Fehlversuch.
  function lies() {
    try { return JSON.parse(localStorage.getItem(SCHLUESSEL) || "null"); }
    catch { return null; }
  }
  function schreib(t) {
    if (t) localStorage.setItem(SCHLUESSEL, JSON.stringify(t));
    else localStorage.removeItem(SCHLUESSEL);
  }

  /* ---- Verschlüsselung ---- */

  // Die Rundenzahl kommt aus dem Tresor, nicht aus der Konstanten: sonst wären
  // alle bestehenden Tresore unbrauchbar, sobald RUNDEN je erhöht wird.
  async function pinSchluessel(pin, salzB64, runden) {
    const roh = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: ausB64(salzB64), iterations: runden || RUNDEN, hash: "SHA-256" },
      roh,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function chiffriere(schluessel, bytes) {
    const iv = zufall(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, schluessel, bytes);
    return { iv: nachB64(iv), ct: nachB64(ct) };
  }
  async function dechiffriere(schluessel, huelle) {
    const klar = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ausB64(huelle.iv) }, schluessel, ausB64(huelle.ct)
    );
    return new Uint8Array(klar);
  }

  async function hsAusRoh(roh, exportierbar) {
    return crypto.subtle.importKey("raw", roh, { name: "AES-GCM" }, !!exportierbar, ["encrypt", "decrypt"]);
  }

  /* ---- Sitzung verschlüsselt ablegen ---- */

  async function sichereSitzung() {
    const t = lies();
    if (!t || !hs) return;
    const bytes = new TextEncoder().encode(JSON.stringify(sitzung));
    t.blob = await chiffriere(hs, bytes);
    schreib(t);
  }

  async function oeffneSitzung() {
    const t = lies();
    if (!t?.blob) { sitzung = {}; return; }
    const klar = await dechiffriere(hs, t.blob);
    sitzung = JSON.parse(new TextDecoder().decode(klar));
  }

  /* ---- Speicher-Adapter für Supabase ----
     Solange kein Tresor eingerichtet ist, verhält sich alles wie bisher
     (Klartext in localStorage). Sobald einer existiert, geht nichts mehr
     unverschlüsselt auf die Platte – und vor dem Entsperren gibt es nichts. */

  const speicher = {
    getItem(k) {
      if (lies()) return hs ? (sitzung[k] ?? null) : null;
      return localStorage.getItem(k);
    },
    async setItem(k, v) {
      if (lies()) { sitzung[k] = v; await sichereSitzung(); return; }
      localStorage.setItem(k, v);
    },
    async removeItem(k) {
      if (lies()) { delete sitzung[k]; await sichereSitzung(); return; }
      localStorage.removeItem(k);
    }
  };

  /* ---- Face ID (WebAuthn mit PRF-Erweiterung) ---- */

  // Die PRF-Erweiterung gibt es erst ab iOS 18 / neueren Browsern. Ohne sie
  // liefert ein Passkey kein ableitbares Geheimnis – dann bleibt nur der PIN.
  async function faceIdMoeglich() {
    if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
    catch { return false; }
  }

  async function prfGeheimnis(credIdB64, prfSalzB64) {
    const zusicherung = await navigator.credentials.get({
      publicKey: {
        challenge: zufall(32),
        rpId: location.hostname,
        allowCredentials: [{ type: "public-key", id: ausB64(credIdB64) }],
        userVerification: "required",
        timeout: 60000,
        extensions: { prf: { eval: { first: ausB64(prfSalzB64) } } }
      }
    });
    const erg = zusicherung?.getClientExtensionResults?.().prf?.results?.first;
    if (!erg) throw new Error("kein-prf");
    return new Uint8Array(erg);
  }

  /* ---- Öffentliche Schnittstelle ---- */

  return {
    speicher,
    PIN_LAENGE,
    MAX_FEHLVERSUCHE,

    eingerichtet: () => !!lies(),
    entsperrt: () => !!hs,
    hatFaceId: () => !!lies()?.bio,
    fehlversuche: () => lies()?.fehl || 0,
    faceIdMoeglich,

    /* PIN einrichten – der Hauptschlüssel entsteht hier ein einziges Mal.
       Die Sitzung, die bis eben im Klartext lag, zieht mit um. */
    async einrichten(pin, klartextSchluessel) {
      const rohHS = zufall(32);
      const salz = nachB64(zufall(16));
      const pk = await pinSchluessel(pin, salz);
      const t = { v: 1, salz, runden: RUNDEN, pin: await chiffriere(pk, rohHS), bio: null, blob: null, fehl: 0 };
      schreib(t);
      hs = await hsAusRoh(rohHS, true);

      // Klartext-Sitzung übernehmen und die alten Einträge entfernen
      sitzung = {};
      for (const k of klartextSchluessel) {
        const v = localStorage.getItem(k);
        if (v !== null) { sitzung[k] = v; localStorage.removeItem(k); }
      }
      await sichereSitzung();
    },

    async entsperreMitPin(pin) {
      const t = lies();
      if (!t) throw new Error("kein-tresor");
      if ((t.fehl || 0) >= MAX_FEHLVERSUCHE) { schreib(null); throw new Error("gesperrt"); }

      // Den Versuch ZUERST verbuchen und wegschreiben. Stünde das erst im
      // catch, könnte jemand die App mitten in der (langsamen) Ableitung
      // abwürgen und hätte beliebig viele Freiversuche – womit die Sperre nach
      // zehn Fehlern, also die eigentliche Verteidigung des kurzen PINs, nichts
      // mehr wert wäre.
      t.fehl = (t.fehl || 0) + 1;
      schreib(t);

      let rohHS;
      try {
        const pk = await pinSchluessel(pin, t.salz, t.runden);
        rohHS = await dechiffriere(pk, t.pin);
      } catch {
        if (t.fehl >= MAX_FEHLVERSUCHE) { schreib(null); throw new Error("gesperrt"); }
        throw new Error("falsch");
      }
      hs = await hsAusRoh(rohHS, true);
      await oeffneSitzung();
      t.fehl = 0;
      schreib(t);
    },

    async entsperreMitFaceId() {
      const t = lies();
      if (!t?.bio) throw new Error("kein-faceid");
      const geheim = await prfGeheimnis(t.bio.credId, t.bio.salz);
      const bk = await crypto.subtle.importKey("raw", geheim, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      const rohHS = await dechiffriere(bk, t.bio.huelle);
      hs = await hsAusRoh(rohHS, true);
      await oeffneSitzung();
      if (t.fehl) { t.fehl = 0; schreib(t); }
    },

    /* Face ID nachrüsten – geht nur im entsperrten Zustand, weil dafür der
       Hauptschlüssel im Klartext gebraucht wird. */
    async faceIdEinrichten(kennung, anzeige) {
      const t = lies();
      if (!t || !hs) throw new Error("gesperrt");
      const prfSalz = zufall(32);
      const nutzerId = zufall(16);

      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: zufall(32),
          rp: { name: "Saray OS", id: location.hostname },
          user: { id: nutzerId, name: kennung || "saray-os", displayName: anzeige || kennung || "Saray OS" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            userVerification: "required",
            residentKey: "preferred"
          },
          timeout: 60000,
          extensions: { prf: { eval: { first: prfSalz } } }
        }
      });
      if (!cred) throw new Error("abgebrochen");
      if (cred.getClientExtensionResults?.().prf?.enabled === false) throw new Error("kein-prf");

      const credId = nachB64(cred.rawId);
      const salzB64 = nachB64(prfSalz);
      // Das Geheimnis holen wir über eine eigene Abfrage: manche Plattformen
      // liefern es beim Anlegen noch nicht mit.
      const geheim = await prfGeheimnis(credId, salzB64);
      const bk = await crypto.subtle.importKey("raw", geheim, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      const rohHS = new Uint8Array(await crypto.subtle.exportKey("raw", hs));
      t.bio = { credId, salz: salzB64, huelle: await chiffriere(bk, rohHS) };
      schreib(t);
    },

    faceIdEntfernen() {
      const t = lies();
      if (!t) return;
      t.bio = null;
      schreib(t);
    },

    async pinAendern(alt, neu) {
      const t = lies();
      if (!t) throw new Error("kein-tresor");
      let rohHS;
      try {
        const pk = await pinSchluessel(alt, t.salz, t.runden);
        rohHS = await dechiffriere(pk, t.pin);
      } catch { throw new Error("falsch"); }
      const salz = nachB64(zufall(16));
      const pk2 = await pinSchluessel(neu, salz, RUNDEN);
      t.salz = salz;
      t.runden = RUNDEN;
      t.pin = await chiffriere(pk2, rohHS);
      t.fehl = 0;
      schreib(t);
    },

    /* Schloss abnehmen: die Sitzung wandert zurück in den Klartext-Speicher,
       sonst wäre man nach dem Aufheben unfreiwillig abgemeldet. */
    aufheben() {
      if (!hs) throw new Error("gesperrt");
      for (const [k, v] of Object.entries(sitzung)) localStorage.setItem(k, v);
      schreib(null);
      hs = null;
      sitzung = {};
    },

    /* Alles Verschlüsselte wegwerfen – nach zu vielen Fehlversuchen oder wenn
       die Sitzung serverseitig nicht mehr gilt. Danach normale Anmeldung. */
    verwerfen() {
      schreib(null);
      hs = null;
      sitzung = {};
    },

    // Die gespeicherten Token, um Supabase die Sitzung zurückzugeben
    sitzungsDaten() {
      for (const wert of Object.values(sitzung)) {
        try {
          const o = JSON.parse(wert);
          if (o?.access_token && o?.refresh_token) return o;
        } catch { /* kein JSON – nächster Eintrag */ }
      }
      return null;
    }
  };
})();
