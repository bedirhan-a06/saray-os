#!/usr/bin/env python3
"""Holt Marken-Logos einmalig von Simple Icons und baut daraus brands.js."""
import json, re, urllib.request, urllib.error

# slug -> (Suchbegriffe, Kategorie)
BRANDS = [
    ("netflix",            ["netflix"],                              "Streaming"),
    ("youtubemusic",       ["youtube music"],                        "Musik"),
    ("youtube",            ["youtube premium", "youtube"],           "Streaming"),
    ("appletv",            ["apple tv", "appletv"],                  "Streaming"),
    ("crunchyroll",        ["crunchyroll"],                          "Streaming"),
    ("dazn",               ["dazn"],                                 "Streaming"),
    ("paramountplus",      ["paramount"],                            "Streaming"),
    ("twitch",             ["twitch"],                               "Streaming"),
    ("sky",                ["sky", "wow"],                           "Streaming"),
    ("rtl",                ["rtl+", "rtl plus", "rtl"],              "Streaming"),
    ("deutschetelekom",    ["telekom", "magenta"],                   "Sonstige"),

    ("spotify",            ["spotify"],                              "Musik"),
    ("applemusic",         ["apple music", "applemusic"],            "Musik"),
    ("deezer",             ["deezer"],                               "Musik"),
    ("soundcloud",         ["soundcloud"],                           "Musik"),
    ("tidal",              ["tidal"],                                "Musik"),

    ("claude",             ["claude", "anthropic"],                  "Software"),
    ("googlegemini",       ["gemini", "google gemini"],              "Software"),
    ("perplexity",         ["perplexity"],                           "Software"),
    ("cursor",             ["cursor"],                               "Software"),
    ("githubcopilot",      ["github copilot", "copilot"],            "Software"),
    ("github",             ["github"],                               "Software"),
    ("notion",             ["notion"],                               "Software"),
    ("figma",              ["figma"],                                "Software"),
    ("1password",          ["1password"],                            "Software"),
    ("bitwarden",          ["bitwarden"],                            "Software"),
    ("nordvpn",            ["nordvpn", "nord vpn"],                  "Software"),
    ("protonmail",         ["proton"],                               "Software"),
    ("todoist",            ["todoist"],                              "Software"),
    ("obsidian",           ["obsidian"],                             "Software"),
    ("jetbrains",          ["jetbrains"],                            "Software"),

    ("playstation",        ["playstation", "ps plus", "psplus"],     "Gaming"),
    ("steam",              ["steam"],                                "Gaming"),
    ("epicgames",          ["epic games", "epicgames"],              "Gaming"),
    ("discord",            ["discord", "nitro"],                     "Gaming"),

    ("icloud",             ["icloud", "apple one"],                  "Cloud"),
    ("dropbox",            ["dropbox"],                              "Cloud"),
    ("googledrive",        ["google drive", "google one", "gdrive"], "Cloud"),
    ("mega",               ["mega"],                                 "Cloud"),

    ("audible",            ["audible"],                              "Sonstige"),
    ("duolingo",           ["duolingo"],                             "Sonstige"),
    ("vodafone",           ["vodafone"],                             "Sonstige"),
    ("strava",             ["strava"],                               "Sonstige"),
    ("patreon",            ["patreon"],                              "Sonstige"),
    ("coursera",           ["coursera"],                             "Sonstige"),
    ("udemy",              ["udemy"],                                "Sonstige"),
]

# Marken, die Simple Icons nicht (mehr) führt, die es aber in anderen
# offenen Sammlungen gibt. Bezogen über die Iconify-API.
#   ri          = Remix Icon (Apache 2.0)
#   devicon     = Devicon (MIT)
# Format: (iconify-name, Suchbegriffe, Kategorie, Hausfarbe, Anzeigename)
ICONIFY = [
    ("ri:openai-fill",        ["chatgpt", "openai"], "Software", "#10A37F", "ChatGPT"),
    ("devicon-plain:lovable", ["lovable"],           "Software", "#FF7EB0", "Lovable"),
]

# Marken, für die es nirgends ein freies Logo gibt.
# Statt Logo: Namenskürzel in der Hausfarbe – optisch trotzdem klar zuzuordnen.
TINTS = [
    ("amazon prime",  "Prime",  "#00A8E1", "Streaming"),
    ("prime video",   "Prime",  "#00A8E1", "Streaming"),
    ("disney+",       "D+",     "#113CCF", "Streaming"),
    ("disney plus",   "D+",     "#113CCF", "Streaming"),
    ("disney",        "D+",     "#113CCF", "Streaming"),
    # GoodNotes fuehrt keine offene Sammlung. Farbe aus dem App-Icon ausgezaehlt.
    ("goodnotes",     "GN",     "#00B4CC", "Software"),
    ("good notes",    "GN",     "#00B4CC", "Software"),
    ("microsoft 365", "365",    "#0078D4", "Software"),
    ("office 365",    "365",    "#0078D4", "Software"),
    ("microsoft",     "MS",     "#0078D4", "Software"),
    ("game pass",     "XB",     "#107C10", "Gaming"),
    ("gamepass",      "XB",     "#107C10", "Gaming"),
    ("xbox",          "XB",     "#107C10", "Gaming"),
    ("nintendo",      "NIN",    "#E60012", "Gaming"),
    ("switch online", "NIN",    "#E60012", "Gaming"),
    ("adobe",         "Ai",     "#FF0000", "Software"),
    ("photoshop",     "Ps",     "#31A8FF", "Software"),
    ("lightroom",     "Lr",     "#31A8FF", "Software"),
    ("creative cloud","Cc",     "#FF0000", "Software"),
    ("canva",         "Cv",     "#00C4CC", "Software"),
    ("linkedin",      "in",     "#0A66C2", "Sonstige"),
    ("amazon",        "az",     "#FF9900", "Sonstige"),
    ("joyn",          "J",      "#FF005C", "Streaming"),
    ("fitness",       "GYM",    "#7dd3a7", "Sonstige"),
    ("gym",           "GYM",    "#7dd3a7", "Sonstige"),
    ("mcfit",         "GYM",    "#7dd3a7", "Sonstige"),
]

out, missing = [], []
for slug, keys, cat in BRANDS:
    if not keys:
        continue
    req = urllib.request.Request(
        f"https://cdn.simpleicons.org/{slug}",
        headers={"User-Agent": "curl/8.7.1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            svg = r.read().decode()
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        missing.append(f"{slug} ({e})")
        continue
    fill = re.search(r'fill="(#[0-9A-Fa-f]{3,6})"', svg)
    title = re.search(r"<title>(.*?)</title>", svg)
    paths = re.findall(r'\sd="([^"]+)"', svg)
    if not paths:
        missing.append(f"{slug} (kein path)")
        continue
    out.append({
        "slug": slug,
        "title": title.group(1) if title else slug,
        "color": fill.group(1) if fill else "#d4af37",
        "path": " ".join(paths),
        "keys": keys,
        "cat": cat,
    })

# Zweite Quelle: Iconify, fuer Marken die Simple Icons nicht (mehr) fuehrt
for name, keys, cat, color, anzeigename in ICONIFY:
    sammlung, icon = name.split(":", 1)
    req = urllib.request.Request(
        f"https://api.iconify.design/{sammlung}.json?icons={icon}",
        headers={"User-Agent": "curl/8.7.1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            daten = json.load(r)
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        missing.append(f"{name} ({e})")
        continue
    eintrag = daten.get("icons", {}).get(icon)
    if not eintrag:
        missing.append(f"{name} (nicht in der Sammlung)")
        continue
    pfade = re.findall(r'\sd="([^"]+)"', eintrag["body"])
    if not pfade:
        missing.append(f"{name} (kein path)")
        continue
    # Diese Sammlungen sind nicht auf 24x24 genormt – Groesse mitschreiben
    breite = eintrag.get("width", daten.get("width", 24))
    hoehe = eintrag.get("height", daten.get("height", 24))
    out.append({
        "slug": name,
        "title": anzeigename,
        "color": color,
        "path": " ".join(pfade),
        "box": None if (breite == 24 and hoehe == 24) else f"0 0 {breite} {hoehe}",
        "keys": keys,
        "cat": cat,
    })

# Längere Suchbegriffe zuerst, damit "youtube music" vor "youtube" greift
flat = []
for b in out:
    for k in b["keys"]:
        eintrag = {"title": b["title"], "color": b["color"], "cat": b["cat"], "path": b["path"]}
        if b.get("box"):
            eintrag["box"] = b["box"]
        flat.append((k, eintrag))
for key, label, color, cat in TINTS:
    flat.append((key, {"title": label, "color": color, "cat": cat, "text": label}))
flat.sort(key=lambda kv: -len(kv[0]))

lines = [
    "/* Saray OS – Markenerkennung für Abo-Logos.",
    " * Logos aus Simple Icons (CC0), Remix Icon (Apache 2.0) und Devicon (MIT),",
    " * einmalig heruntergeladen und lokal eingebettet, damit die App offline",
    " * läuft und keine Daten an Dritte gehen.",
    " * Marken ohne freies Logo bekommen ein Kürzel in der Hausfarbe.",
    " * Marken- und Namensrechte liegen bei den jeweiligen Unternehmen.",
    " * Erzeugt von tools/gen_brands.py – nicht von Hand bearbeiten.",
    " * Neue Marke aufnehmen: dort in BRANDS bzw. TINTS ergänzen, dann",
    " *   python3 tools/gen_brands.py",
    " */",
    "const BRANDS = [",
]
for key, b in flat:
    parts = ["key: %s" % json.dumps(key), "title: %s" % json.dumps(b["title"]),
             "color: %s" % json.dumps(b["color"]), "cat: %s" % json.dumps(b["cat"])]
    if "path" in b:
        parts.append("path: %s" % json.dumps(b["path"]))
        if b.get("box"):
            parts.append("box: %s" % json.dumps(b["box"]))
    else:
        parts.append("text: %s" % json.dumps(b["text"]))
    lines.append("  { %s }," % ", ".join(parts))
lines += ["];", ""]

with open("/Users/bedooooo/websites/saray-os/brands.js", "w") as f:
    f.write("\n".join(lines))

print(f"{len(out)} Marken, {len(flat)} Suchbegriffe")
if missing:
    print("Nicht gefunden:", ", ".join(missing))
