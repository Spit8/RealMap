#!/usr/bin/env python3
"""Draft tools/i18n/glossary.json from Transport Fever 3's own translations (read-only).

The game ships gettext catalogs (msgid = English) in <game>/base/strings/<lang>/LC_MESSAGES/base.mo.
Game terms are taken from there (so the app speaks like the game); terms the game does not have
(heightmap import, land cover, OpenStreetMap…) are proposals marked "to review". The industry and
cargo names come from the game too (INDUSTRIES_<TYPE>_NAME and the cargo msgids), so the app names
them exactly as the game does. The draft is then reviewed by hand:
this script does not overwrite glossary.json unless --force.

  python tools/i18n/glossary_extract.py [--game "E:/Transport Fever 3"] [--force]
"""
from __future__ import annotations

import argparse
import gettext
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
LANGS = {"fr": "fr", "de": "de", "it": "it", "es": "es", "zh": "zh_CN"}  # zh: Simplified only

# (English term in the app's text, other English forms, game msgids [singular, plural]).
GAME_TERMS: list[tuple[str, list[str], list[str]]] = [
    ("town", ["towns"], ["Town", "Towns"]),
    ("industry", ["industries"], ["Industry", "Industries"]),
    ("road", ["roads"], ["Road", "Roads"]),
    ("bridge", ["bridges"], ["Bridge", "Bridges"]),
    ("tunnel", ["tunnels"], ["Tunnel", "Tunnels"]),
    ("Map Editor", [], ["Map Editor"]),
    ("heightmap", [], ["Heightmap"]),
    ("biomes", [], ["Biomes"]),
    ("terrain", [], ["Terrain"]),
    ("economy", [], ["Economy"]),
    ("climate", [], ["Climate"]),
    ("capacity", [], ["Capacity"]),
    ("demand", ["demands"], ["Demand"]),
    ("water level", [], ["Water Level"]),
    ("population", [], ["Population"]),
    ("mod", ["mods"], ["Mods"]),
    ("temperate", [], ["Temperate"]),
    ("dry", [], ["Dry"]),
    ("tropical", [], ["Tropical"]),
    ("subarctic", [], ["Subarctic"]),
    ("beverages", [], ["Beverages"]),
    ("books", [], ["Books"]),
    ("clothes", [], ["Clothes"]),
    ("fish", [], ["Fish"]),
    ("meat", [], ["Meat"]),
    ("vegetables", [], ["Vegetables"]),
    ("bricks", [], ["Bricks"]),
    ("cement", [], ["Cement"]),
    ("fuel", [], ["Fuel"]),
    ("furniture", [], ["Furniture"]),
    ("machines", [], ["Machines"]),
    ("planks", [], ["Planks"]),
    ("tools", [], ["Tools"]),
    ("vehicles", [], ["Vehicles"]),
]

# Industry types: msgid INDUSTRIES_<TAG>_NAME, English from the game's en catalog.
INDUSTRY_TAGS = [
    "farm", "livestock_farm", "cotton_farm", "rubber_farm", "forest", "quarry", "clay_pit", "sand_pit", "sand_excavator",
    "coal_mine", "iron_ore_mine", "oil_well", "oil_platform", "fishing_grounds", "oil_refinery", "chemical_plant", "steel_mill",
    "saw_mill", "brewery", "bricks_works", "glass_works", "food_factory", "weaving_mill", "textile_factory", "furniture_factory",
    "machine_factory", "tool_factory", "vehicle_factory", "cement_plant", "paper_mill", "printing_press", "tire_factory",
]

# Game values that do not fit the app's sense: replaced, with the reason.
GAME_FIXES: dict[tuple[str, str], tuple[list[str], str]] = {
    ("mod", "de"): (["Mod", "Mods"], "game gives the plural only"),
    ("mod", "it"): (["mod"], ""),
    ("mod", "es"): (["mod", "mods"], "game gives the plural only"),
    ("mod", "fr"): (["mod", "mods"], ""),
}

EXTRA_GAME: list[dict] = [
    {"en": "tinned food", "forms": [], "fr": "conserves", "note": "game msgid not found under this name: to review"},
]

# Terms of the app the game does not have: proposals.
APP_TERMS: list[dict] = [
    {"en": "relief", "forms": [], "fr": "relief", "de": "Relief", "it": "rilievo", "es": "relieve", "zh": "地形"},
    {"en": "land cover", "forms": [], "fr": "occupation du sol", "de": "Bodenbedeckung", "it": "copertura del suolo",
     "es": "cobertura del suelo", "zh": "土地覆盖"},
    {"en": "area", "forms": ["areas"], "fr": "zone", "de": "Gebiet", "it": "zona", "es": "zona", "zh": "区域",
     "note": "the real-world area turned into the game map"},
    {"en": "railway line", "forms": ["railway lines", "railway"], "fr": "voie ferrée", "de": ["Bahnstrecke", "Bahnstrecken"],
     "it": ["linea ferroviaria", "linee ferroviarie"], "es": ["línea de ferrocarril", "líneas de ferrocarril"], "zh": "铁路线",
     "note": "a railway track to build, not a transport line"},
    {"en": "road link", "forms": ["road links"], "fr": "liaison routière", "de": ["Straßenverbindung", "Straßenverbindungen"],
     "it": ["collegamento stradale", "collegamenti stradali"], "es": ["enlace por carretera", "enlaces por carretera"], "zh": "公路连接"},
    {"en": "bank", "forms": ["banks"], "fr": "berge", "de": ["Ufer"], "it": ["sponda", "sponde"], "es": ["orilla", "orillas"], "zh": "河岸",
     "note": "river or lake bank (not a financial bank)"},
    {"en": "sea floor", "forms": [], "fr": "fonds marins", "de": "Meeresboden", "it": "fondale marino", "es": "fondo marino", "zh": "海底"},
    {"en": "legend", "forms": [], "fr": "légende", "de": "Legende", "it": "legenda", "es": "leyenda", "zh": "图例"},
    {"en": "log", "forms": [], "fr": "journal", "de": "Protokoll", "it": "registro", "es": "registro", "zh": "日志",
     "note": "the app's message log (tab name)"},
]

KEEP = ["RealMap", "importcity", "Transport Fever 3", "TF3", "OpenStreetMap", "OSM", "IGN", "RGE ALTI", "Copernicus", "GLO-30",
        "ESA", "WorldCover", "EMODnet", "ETOPO", "userdata", "Ctrl", "Esc", "km", "km²", "ha"]

STYLE = {
    "de": {"register": "Address the user informally with 'du' (as the game does). Swiss orthography as in the game: write 'ss', never 'ß'.",
           "button": "Commands (buttons, menu items, and labels or tooltips naming an action): infinitive form, as the game does ('Speichern', 'Diese Konfiguration löschen'). A status that something is in progress: 'Wird …'."},
    "it": {"register": "Address the user informally with 'tu' (as the game does). 'mod' is feminine: 'la mod'.",
           "button": "Commands (buttons, menu items, and labels or tooltips naming an action): imperative 2nd person singular, as the game does ('Salva', 'Elimina questa configurazione')."},
    "es": {"register": "Address the user informally with 'tú' (as the game does). 'mod' is masculine: 'el mod'.",
           "button": "Commands (buttons, menu items, and labels or tooltips naming an action): infinitive form, as the game does ('Guardar', 'Eliminar esta configuración')."},
    "zh": {"register": "Simplified Chinese only (zh-Hans). Address the user with '你' (as the game does).",
           "button": "Commands (buttons, menu items, and labels or tooltips naming an action): short verb phrase, as the game does ('保存', '删除此配置')."},
}


EVIDENCE_SENTENCES = [
    "The line manager lets you manage all the lines.",
    "If you already feel confident, you can end the tutorial at any time.",
    "Use the cargo filter in the vehicle store to filter by the cargo type you're interested in.",
]
EVIDENCE_BUTTONS = ["Save", "Delete", "Rename"]


def catalogs(game: Path) -> dict[str, dict]:
    out = {}
    for code, folder in LANGS.items():
        with (game / "base" / "strings" / folder / "LC_MESSAGES" / "base.mo").open("rb") as f:
            out[code] = gettext.GNUTranslations(f)._catalog
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--game", type=Path, default=Path("E:/Transport Fever 3"))
    p.add_argument("--force", action="store_true")
    a = p.parse_args()
    target = HERE / "glossary.json"
    if target.exists() and not a.force:
        raise SystemExit(f"{target} exists (reviewed by hand): --force to draft it again")
    cats = catalogs(a.game)
    with (a.game / "base" / "strings" / "en" / "LC_MESSAGES" / "base.mo").open("rb") as f:
        en_cat = gettext.GNUTranslations(f)._catalog
    terms = []
    for en, forms, msgids in GAME_TERMS:
        t: dict = {"en": en, "forms": forms, "source": "game: " + " / ".join(msgids)}
        for code in LANGS:
            vals = []
            for m in msgids:
                v = cats[code].get(m)
                if isinstance(v, str) and v not in vals:
                    vals.append(v)
            fix = GAME_FIXES.get((en, code))
            if fix:
                vals = fix[0]
                if fix[1]:
                    t.setdefault("note", "")
                    t["note"] = (t["note"] + "; " if t["note"] else "") + f"{code}: {fix[1]}"
            if code in ("fr", "it", "es"):
                # Game titles are capitalised; in the app's sentences these words are common nouns.
                vals = [v[:1].lower() + v[1:] for v in vals]
            t[code] = vals[0] if len(vals) == 1 else vals
        terms.append(t)
    for tag in INDUSTRY_TAGS:
        key = f"INDUSTRIES_{tag.upper()}_NAME"
        t = {"en": en_cat.get(key, tag), "forms": [], "source": f"game: {key}"}
        for code in LANGS:
            if cats[code].get(key):
                t[code] = cats[code][key]
        terms.append(t)
    terms += EXTRA_GAME
    terms += [{**t, "note": (t.get("note", "") + ("; " if t.get("note") else "") + "app term: to review")} for t in APP_TERMS]
    # The game's own sentences and buttons behind each style rule (for the review; not sent to the model).
    style = {code: {**rules, "evidence": {
        "register": [cats[code].get(m) for m in EVIDENCE_SENTENCES],
        "button": [cats[code].get(m) for m in EVIDENCE_BUTTONS],
    }} for code, rules in STYLE.items()}
    ctx = json.loads((HERE / "context.json").read_text(encoding="utf-8"))
    out = {"app": ctx["app"], "keep": KEEP, "style": style, "terms": terms}
    target.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{target}: {len(terms)} terms ({len(GAME_TERMS) + len(INDUSTRY_TAGS) + len(EXTRA_GAME)} from the game, {len(APP_TERMS)} app proposals)")


if __name__ == "__main__":
    main()
