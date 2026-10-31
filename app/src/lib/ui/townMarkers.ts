/**
 * Town and industry markers shared by the area map and the preview. Towns: green = will be a
 * town, orange = not chosen, grey = chosen but not placed (dropped or over the limit). Industries:
 * squares coloured by kind (primary, factory, on water), hollow when not chosen, grey when not
 * placed. Markers carry their key (feature property `townKey` / `industryKey`): a click opens
 * their sheet (`townDetails` / `industryDetails`), a right click adds or removes them.
 */
import Feature from "ol/Feature";
import { Point } from "ol/geom";
import { Circle as CircleStyle, Fill, RegularShape, Stroke, Style, Text } from "ol/style";
import { INDUSTRIES, type IndustryCandidate } from "$lib/core/industries";
import type { CandidateStatus, MapTown, TownCandidate } from "$lib/core/towns";

/** A marker's sheet: a title and a few lines. */
export interface MarkerDetails {
  title: string;
  lines: string[];
}

const ORIGIN_LABELS = { osm: "site réel (OpenStreetMap)", landcover: "occupation du sol", chain: "chaîne de production" };

/** Industry square colours: primary (fields, mines, forests), factory, on water. */
export const INDUSTRY_COLORS = { primary: "#a0702a", factory: "#7b4bb5", water: "#1f6fa8" };

export function industryColor(tag: string): string {
  const d = INDUSTRIES[tag];
  return d?.water ? INDUSTRY_COLORS.water : d?.primary ? INDUSTRY_COLORS.primary : INDUSTRY_COLORS.factory;
}

export function industryFeature(c: IndustryCandidate, coord: number[]): Feature {
  const f = new Feature(new Point(coord));
  f.set("industryKey", c.key);
  const placed = c.status === "placed";
  const color = c.status === "placed" || c.status === "off" ? industryColor(c.tag) : "#8c949c";
  f.setStyle(
    new Style({
      zIndex: placed ? 2 : 0,
      // Symbols always drawn; only the names give way to each other when they overlap.
      image: new RegularShape({
        declutterMode: "none",
        points: 4,
        radius: placed ? 7 : 5,
        angle: Math.PI / 4,
        fill: c.status === "off" ? new Fill({ color: "rgba(255,255,255,0.6)" }) : new Fill({ color }),
        stroke: new Stroke({ color: c.status === "off" ? color : "#fff", width: c.status === "off" ? 2 : 1.5 }),
      }),
      text: placed
        ? new Text({
            text: c.name,
            offsetY: 14,
            font: "11px system-ui, sans-serif",
            fill: new Fill({ color: "#3a3f45" }),
            stroke: new Stroke({ color: "#fff", width: 3 }),
          })
        : undefined,
    }),
  );
  return f;
}

function industryState(c: IndustryCandidate): string {
  const what = c.status === "placed" ? "placée" : c.status === "off" ? "non retenue" : `non placée : ${c.reason ?? "pas de place"}`;
  return `${what}${c.pick !== null ? " (choix manuel)" : ""}`;
}

/** Hover text of an industry marker. */
export function industryTitle(c: IndustryCandidate): string {
  return `${c.name} (${c.label}) · ${industryState(c)}${c.missing ? ` · il manque : ${c.missing.join(", ")}` : ""}`;
}

export function industryDetails(c: IndustryCandidate): MarkerDetails {
  const lines = [
    `Origine : ${ORIGIN_LABELS[c.origin]}`,
    ...(c.why ? [`Pourquoi : ${c.why}`] : []),
    `Présence réelle : ${c.relevance ? c.relevance.toLocaleString("fr-FR") : "aucune"}`,
    `État : ${industryState(c)}`,
  ];
  if (c.missing) lines.push(`Il manque à sa chaîne : ${c.missing.join(", ")}`);
  return { title: c.name, lines: [`Type : ${c.label}`, ...lines] };
}

export const TOWN_COLORS: Record<CandidateStatus, string> = {
  placed: "#2e9d4a",
  off: "#e8912d",
  dropped: "#8c949c",
  limit: "#8c949c",
};

/** Radius (px) from the target capacity: 300 (10 000 inhabitants by default) → 9 px. */
export function townRadius(capacity: number | undefined): number {
  return capacity ? Math.max(5, Math.min(16, 9 * Math.sqrt(capacity / 300))) : 4;
}

export function townStyle(c: TownCandidate): Style {
  const placed = c.status === "placed";
  const r = placed ? townRadius(c.capacity) : c.status === "off" ? 4 : 6;
  return new Style({
    zIndex: placed ? 3 : c.status === "off" ? 1 : 2,
    image: new CircleStyle({
      declutterMode: "none",
      radius: r,
      fill: new Fill({ color: TOWN_COLORS[c.status] + (placed ? "cc" : "aa") }),
      stroke: new Stroke({ color: "#fff", width: 1.5, lineDash: c.status === "dropped" || c.status === "limit" ? [3, 2] : undefined }),
    }),
    text: new Text({
      text: c.name,
      offsetY: -(r + 8),
      font: `${placed ? 600 : 400} 12px system-ui, sans-serif`,
      fill: new Fill({ color: placed ? "#1d2329" : "#5b6670" }),
      stroke: new Stroke({ color: "#fff", width: 3 }),
    }),
  });
}

/** One marker at `coord` (map coordinates). */
export function townFeature(c: TownCandidate, coord: number[]): Feature {
  const f = new Feature(new Point(coord));
  f.set("townKey", c.key);
  f.setStyle(townStyle(c));
  return f;
}

function townState(c: TownCandidate): string {
  const what =
    c.status === "placed" ? `ville, capacité ${c.capacity}`
    : c.status === "off" ? "non retenue"
    : `retenue mais non placée : ${c.reason ?? "pas de place"}`;
  return `${what}${c.pick !== null ? " (choix manuel)" : ""}`;
}

const pop = (c: TownCandidate) => `${c.estimated ? "≈ " : ""}${c.rank.toLocaleString("fr-FR")} hab.`;

/** Hover text of a town marker. */
export function townTitle(c: TownCandidate): string {
  return `${c.name} · ${pop(c)} · ${townState(c)}`;
}

const PLACE_LABELS: Record<string, string> = { city: "ville", town: "petite ville", village: "village" };

/** `t`: the placed town, when it is one. */
export function townDetails(c: TownCandidate, t?: MapTown): MarkerDetails {
  const lines = [`Population : ${pop(c)}${c.estimated ? " (estimée d'après le type de lieu)" : ""}`];
  if (t) lines.push(`OpenStreetMap : ${PLACE_LABELS[t.place] ?? t.place}`);
  lines.push(`État : ${townState(c)}`);
  if (t && t.shift > 1) lines.push(`Déplacée de ${Math.round(t.shift)} m : ${t.moveReason ?? "terrain non constructible"}`);
  return { title: c.name, lines };
}

/** How many of the places not chosen stay listed and drawn (the most populous ones). */
export const SHOWN_OFF = 10;

/**
 * Places worth showing: every chosen town (placed or not) and the `SHOWN_OFF` most populous of the
 * others. `candidates` come sorted by population.
 */
export function shownTownKeys(candidates: TownCandidate[]): Set<string> {
  const keys = new Set<string>();
  let off = 0;
  for (const c of candidates) {
    if (c.status !== "off") keys.add(c.key);
    else if (off < SHOWN_OFF) {
      keys.add(c.key);
      off++;
    }
  }
  return keys;
}

/** Lower case without accents, for « Cher » → Cherbourg, « ecu » → Écully. */
export function foldName(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
}
