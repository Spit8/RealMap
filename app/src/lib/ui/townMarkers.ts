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
import { fmtNum, t as tr, tk, tm } from "$lib/i18n/index.svelte";

/** A marker's sheet: a title and a few lines. */
export interface MarkerDetails {
  title: string;
  lines: string[];
}

/** Translated name of an industry type, a cargo. */
export const industryLabel = (tag: string) => tk(`industry.${tag}`);
export const cargoLabel = (cargo: string) => tk(`cargo.${cargo}`);

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
  const what =
    c.status === "placed" ? tr("sheet.industryPlaced")
    : c.status === "off" ? tr("sheet.industryOff")
    : tr("sheet.industryDropped", { reason: c.reason ? tm(c.reason) : tr("sheet.noRoom") });
  return `${what}${c.pick !== null ? ` ${tr("sheet.manual")}` : ""}`;
}

/** Hover text of an industry marker. */
export function industryTitle(c: IndustryCandidate): string {
  return `${c.name} (${industryLabel(c.tag)}) · ${industryState(c)}${c.missing ? ` · ${tr("sheet.missingShort", { list: c.missing.map(industryLabel).join(", ") })}` : ""}`;
}

export function industryDetails(c: IndustryCandidate): MarkerDetails {
  const lines = [
    tr("sheet.origin", { origin: tk(`origin.${c.origin}`) }),
    ...(c.why ? [tr("sheet.why", { why: tm(c.why) })] : []),
    tr("sheet.relevance", { n: c.relevance ? fmtNum(c.relevance, 1) : tr("sheet.relevanceNone") }),
    tr("sheet.state", { state: industryState(c) }),
  ];
  if (c.missing) lines.push(tr("sheet.missing", { list: c.missing.map(industryLabel).join(", ") }));
  return { title: c.name, lines: [tr("sheet.type", { type: industryLabel(c.tag) }), ...lines] };
}

export const TOWN_COLORS: Record<CandidateStatus, string> = {
  placed: "#2e9d4a",
  off: "#FD9401",
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
    c.status === "placed" ? tr("sheet.townPlaced", { n: c.capacity ?? 0 })
    : c.status === "off" ? tr("sheet.townOff")
    : tr("sheet.townDropped", { reason: c.reason ? tm(c.reason) : tr("sheet.noRoom") });
  return `${what}${c.pick !== null ? ` ${tr("sheet.manual")}` : ""}`;
}

const pop = (c: TownCandidate) => `${c.estimated ? "≈ " : ""}${tr("sheet.inhabitants", { n: fmtNum(c.rank) })}`;

/** Hover text of a town marker. */
export function townTitle(c: TownCandidate): string {
  return `${c.name} · ${pop(c)} · ${townState(c)}`;
}

/** `t`: the placed town, when it is one. */
export function townDetails(c: TownCandidate, t?: MapTown): MarkerDetails {
  const lines = [tr("sheet.population", { pop: pop(c) }) + (c.estimated ? ` ${tr("sheet.estimated")}` : "")];
  if (t) lines.push(tr("sheet.osmPlace", { kind: tk(`place.${t.place}`) }));
  lines.push(tr("sheet.state", { state: townState(c) }));
  if (t && t.shift > 1) lines.push(tr("sheet.moved", { m: Math.round(t.shift), reason: t.moveReason ? tm(t.moveReason) : tr("sheet.movedDefault") }));
  if (t?.shares) {
    const pct = (v: number) => `${Math.round(v * 100)} %`;
    lines.push(
      tr("sheet.districts", {
        res: pct(t.shares.res),
        com: pct(t.shares.com),
        ind: pct(t.shares.ind),
        how: tr(t.shares.real ? "sheet.districtsReal" : "sheet.districtsDefault"),
      }),
    );
  }
  if (t?.needs) lines.push(tr("sheet.needs", { needs: needsText(t.needs) }));
  return { title: c.name, lines };
}

/** « commercial: vegetables · industrial: planks » (or the game's own draw). */
export function needsText(n: { com: string[]; ind: string[] }): string {
  const list = (l: string[]) => l.map(cargoLabel).join(", ");
  const parts = [n.com.length ? tr("sheet.needsCom", { list: list(n.com) }) : "", n.ind.length ? tr("sheet.needsInd", { list: list(n.ind) }) : ""];
  return parts.filter(Boolean).join(" · ") || tr("sheet.needsGame");
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
