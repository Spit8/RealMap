<script lang="ts">
  /**
   * OpenStreetMap background with the covered real area (the map's square, north up) and the game
   * tile grid when it is readable. Two views on top:
   *  - « Données réelles » (phase 1): the raw OSM water, places, industrial sites, main roads and
   *    railways as fetched;
   *  - « Résultat jeu » (phase 2): the game map image (reprojected by OpenLayers from the map's
   *    own projection), the chosen towns plus the 10 most populous others (green = town, orange =
   *    not chosen, grey = not placed), moved towns linked to their OSM position, the industries,
   *    the planned road links (brown) and railway (black).
   * Ctrl held: a ghost of the area follows the mouse; Ctrl + click moves the area there. Click on a
   * town / industry: its sheet. Right click: add or remove it. Hover: what is under the cursor in
   * the game (height, water, land cover).
   */
  import { onMount } from "svelte";
  import "ol/ol.css";
  import Map from "ol/Map";
  import View from "ol/View";
  import Overlay from "ol/Overlay";
  import TileLayer from "ol/layer/Tile";
  import ImageLayer from "ol/layer/Image";
  import VectorLayer from "ol/layer/Vector";
  import VectorSource from "ol/source/Vector";
  import ImageStatic from "ol/source/ImageStatic";
  import OSM from "ol/source/OSM";
  import Feature from "ol/Feature";
  import { LineString, Point, Polygon } from "ol/geom";
  import { fromLonLat, toLonLat } from "ol/proj";
  import { register } from "ol/proj/proj4";
  import proj4 from "proj4";
  import { Fill, RegularShape, Stroke, Style, Circle as CircleStyle } from "ol/style";
  import { frameOutline, frameProjection, makeFrame, TILE_M, type Frame } from "$lib/core/area";
  import { b64ToBytes, b64ToFloats } from "$lib/core/b64";
  import { COVER_LABELS } from "$lib/core/biomes";
  import { COVER_RGB, WATER_RGB } from "$lib/core/preview";
  import { WATER_LAKE, WATER_RIVER, WATER_SEA } from "$lib/core/terrain";
  import type { PreviewState, RealLayer } from "$lib/state/importer.svelte";
  import {
    INDUSTRY_COLORS, TOWN_COLORS, industryColor, industryDetails, industryFeature, industryTitle, shownTownKeys, townDetails, townFeature,
    townTitle, type MarkerDetails,
  } from "./townMarkers";

  let {
    frame,
    preview,
    real = null,
    view = "game",
    opacity = 0.85,
    hideOff = false,
    linkPicks = {},
    onPick,
    onToggleTown,
    onToggleIndustry,
  }: {
    frame: Frame;
    preview: PreviewState | null;
    real?: RealLayer | null;
    view?: "real" | "game";
    opacity?: number;
    /** Hide the places and industries that are not chosen (points and names). */
    hideOff?: boolean;
    /** Road links / railway lines left out by hand: drawn dashed and pale. */
    linkPicks?: Record<string, boolean>;
    onPick: (lon: number, lat: number) => void;
    onToggleTown?: (key: string) => void;
    onToggleIndustry?: (key: string) => void;
  } = $props();

  let el: HTMLDivElement;
  let popupEl: HTMLDivElement;
  let tip = $state("");
  let legendOpen = $state(false);
  /** The open sheet: which marker, so it follows the marker's updates. */
  let sheet = $state<{ town?: string; industry?: string } | null>(null);
  let map: Map | undefined;
  let popup: Overlay | undefined;
  const source = new VectorSource();
  const markerSource = new VectorSource();
  const realSource = new VectorSource();
  const imageLayer = new ImageLayer();
  const markerLayer = new VectorLayer({ source: markerSource, declutter: true });
  const realLayer = new VectorLayer({ source: realSource });
  const networkSource = new VectorSource();
  const networkLayer = new VectorLayer({ source: networkSource });
  /** The area's outline under the mouse while Ctrl is held. */
  const ghostSource = new VectorSource();
  const ghostLayer = new VectorLayer({ source: ghostSource });
  let ctrl = false;
  let lastPixel: number[] | null = null;

  const outlineStyle = new Style({
    stroke: new Stroke({ color: "#e4572e", width: 2 }),
    fill: new Fill({ color: "rgba(228, 87, 46, 0.06)" }),
  });
  const gridStyle = new Style({ stroke: new Stroke({ color: "rgba(228, 87, 46, 0.3)", width: 1 }) });
  const centreStyle = new Style({
    image: new CircleStyle({ radius: 5, fill: new Fill({ color: "#e4572e" }), stroke: new Stroke({ color: "#fff", width: 2 }) }),
  });
  const shiftStyle = new Style({ stroke: new Stroke({ color: "#c82828", width: 2, lineDash: [6, 4] }) });
  const rawWater = new Style({ stroke: new Stroke({ color: "#1565c0", width: 2 }), fill: new Fill({ color: "rgba(21, 101, 192, 0.35)" }) });
  const rawPlace = new Style({ image: new CircleStyle({ radius: 3, fill: new Fill({ color: "#2e9d4a" }), stroke: new Stroke({ color: "#fff", width: 1 }) }) });
  const rawSite = (tag: string) =>
    new Style({ image: new RegularShape({ points: 4, radius: 5, angle: Math.PI / 4, fill: new Fill({ color: industryColor(tag) }), stroke: new Stroke({ color: "#fff", width: 1 }) }) });
  const ghostStyle = new Style({
    stroke: new Stroke({ color: "#e4572e", width: 2, lineDash: [8, 6] }),
    fill: new Fill({ color: "rgba(228, 87, 46, 0.1)" }),
  });
  const linkStyle = (on: boolean, real: boolean) =>
    new Style({ stroke: new Stroke({ color: on ? "#8b5a2b" : "rgba(139, 90, 43, 0.35)", width: on ? 3 : 2, lineDash: on && real ? undefined : [6, 5] }) });
  const railStyle = (on: boolean) => [
    new Style({ stroke: new Stroke({ color: on ? "#1d2329" : "rgba(29, 35, 41, 0.35)", width: 4 }) }),
    new Style({ stroke: new Stroke({ color: "#fff", width: 2, lineDash: [8, 8] }) }),
  ];
  const rawRoad = new Style({ stroke: new Stroke({ color: "rgba(139, 90, 43, 0.6)", width: 1.5 }) });
  const rawRail = new Style({ stroke: new Stroke({ color: "rgba(29, 35, 41, 0.7)", width: 2, lineDash: [6, 3] }) });
  const rgb = (c: [number, number, number]) => `rgb(${c.join(",")})`;
  const m = (x: number) => `${x.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} m`;

  function draw(f: Frame): void {
    source.clear();
    const outline = new Feature(new Polygon([frameOutline(f).map((ll) => fromLonLat(ll))]));
    outline.setStyle(outlineStyle);
    source.addFeature(outline);
    // Game tiles (256 m in game) only while there are few enough to read.
    if (f.tilesX * f.tilesY <= 64 * 64) {
      const p = frameProjection(f);
      const hx = f.widthM / 2;
      const hy = f.heightM / 2;
      const add = (a: [number, number], b: [number, number]) => {
        const line = new Feature(new LineString([fromLonLat(p.toLonLat(...a)), fromLonLat(p.toLonLat(...b))]));
        line.setStyle(gridStyle);
        source.addFeature(line);
      };
      for (let i = 1; i < f.tilesX; i++) add([-hx + i * TILE_M, -hy], [-hx + i * TILE_M, hy]);
      for (let j = 1; j < f.tilesY; j++) add([-hx, -hy + j * TILE_M], [hx, -hy + j * TILE_M]);
    }
    const centre = new Feature(new Point(fromLonLat([f.area.lon, f.area.lat])));
    centre.setStyle(centreStyle);
    source.addFeature(centre);
  }

  function showPreview(p: PreviewState | null, hide: boolean): void {
    markerSource.clear();
    if (!p) {
      imageLayer.setSource(null);
      return;
    }
    const f = p.frame;
    // The map's own projection (transverse Mercator centred on the area), registered once per centre.
    const code = `ICITY:${f.area.lon},${f.area.lat}`;
    if (!proj4.defs(code)) {
      proj4.defs(code, f.proj);
      register(proj4);
    }
    const hx = (f.widthM / 2) * f.scale;
    const hy = (f.heightM / 2) * f.scale;
    imageLayer.setSource(new ImageStatic({ url: p.url, projection: code, imageExtent: [-hx, -hy, hx, hy], interpolate: true }));
    // Placed towns / industries at their final (possibly moved) position, the others where they were found.
    const towns = new globalThis.Map((p.towns ?? []).map((t) => [t.key, t]));
    const shown = shownTownKeys(p.candidates ?? []);
    for (const c of p.candidates ?? []) {
      if (!shown.has(c.key) || (hide && c.status === "off")) continue;
      const t = towns.get(c.key);
      if (t && t.shift > 1) {
        const line = new Feature(new LineString([fromLonLat([c.lon, c.lat]), fromLonLat([t.lon, t.lat])]));
        line.setStyle(shiftStyle);
        markerSource.addFeature(line);
      }
      markerSource.addFeature(townFeature(c, fromLonLat(t ? [t.lon, t.lat] : [c.lon, c.lat])));
    }
    const inds = new globalThis.Map((p.industries ?? []).map((x) => [x.key, x]));
    for (const c of p.industryCandidates ?? []) {
      if (hide && c.status === "off") continue;
      const x = inds.get(c.key);
      markerSource.addFeature(industryFeature(c, fromLonLat(x ? [x.lon, x.lat] : [c.lon, c.lat])));
    }
  }

  function showNetwork(p: PreviewState | null, picks: Record<string, boolean>): void {
    networkSource.clear();
    const net = p?.network;
    if (!net) return;
    for (const l of net.links) {
      const ll = net.ll[l.key];
      if (!ll) continue;
      const feat = new Feature(new LineString(ll.map((pt) => fromLonLat(pt))));
      feat.setStyle(linkStyle(picks[l.key] !== false, l.real));
      networkSource.addFeature(feat);
    }
    for (const r of net.rail) {
      const ll = net.ll[r.key];
      if (!ll) continue;
      const feat = new Feature(new LineString(ll.map((pt) => fromLonLat(pt))));
      feat.setStyle(railStyle(picks[r.key] !== false));
      networkSource.addFeature(feat);
    }
  }

  /** The outline the area would have with its centre at this pixel (Ctrl held). */
  function showGhost(pixel: number[] | null): void {
    ghostSource.clear();
    if (!pixel || !map) return;
    const [lon, lat] = toLonLat(map.getCoordinateFromPixel(pixel));
    const f = makeFrame({ ...frame.area, lon, lat });
    const feat = new Feature(new Polygon([frameOutline(f).map((ll) => fromLonLat(ll))]));
    feat.setStyle(ghostStyle);
    ghostSource.addFeature(feat);
  }

  function showReal(r: RealLayer | null): void {
    realSource.clear();
    if (!r) return;
    for (const w of r.roads ?? []) {
      const feat = new Feature(new LineString(w.pts.map((pt) => fromLonLat(pt))));
      feat.setStyle(w.kind === "rail" ? rawRail : rawRoad);
      feat.set("tip", `${w.kind === "rail" ? "Voie ferrée" : "Route"} ${w.cls}${w.name ? ` · ${w.name}` : ""}`);
      realSource.addFeature(feat);
    }
    for (const s of r.water) {
      const geom =
        s.kind === "line"
          ? new LineString(s.pts.map((pt) => fromLonLat(pt)))
          : new Polygon(s.rings.map((ring) => ring.map((pt) => fromLonLat(pt))));
      const feat = new Feature(geom);
      feat.setStyle(rawWater);
      realSource.addFeature(feat);
    }
    for (const pl of r.places) {
      const feat = new Feature(new Point(fromLonLat([pl.lon, pl.lat])));
      feat.setStyle(rawPlace);
      feat.set("tip", `${pl.name} (${pl.place}${pl.population ? `, ${pl.population.toLocaleString("fr-FR")} hab.` : ""})`);
      realSource.addFeature(feat);
    }
    for (const s of r.sites) {
      const feat = new Feature(new Point(fromLonLat([s.lon, s.lat])));
      feat.setStyle(rawSite(s.tag));
      feat.set("tip", `${s.name ? `${s.name} · ` : ""}${s.why} → ${s.tag}`);
      realSource.addFeature(feat);
    }
  }

  function keyAt(pixel: number[]): { town?: string; industry?: string; tip?: string } {
    return (
      map?.forEachFeatureAtPixel(
        pixel,
        (f) => {
          if (f.get("townKey")) return { town: f.get("townKey") as string };
          if (f.get("industryKey")) return { industry: f.get("industryKey") as string };
          if (f.get("tip")) return { tip: f.get("tip") as string };
          return undefined;
        },
        { hitTolerance: 4 },
      ) ?? {}
    );
  }

  const hover = $derived(
    preview?.hover
      ? { ...preview.hover, z: b64ToFloats(preview.hover.heights), w: b64ToBytes(preview.hover.water), c: b64ToBytes(preview.hover.cover) }
      : null,
  );

  /** What the game map has at a lon/lat (game height, water, land cover). */
  function describe(lon: number, lat: number): string {
    const p = preview;
    const h = hover;
    if (!p || !h || view !== "game") return "";
    const [x, y] = frameProjection(p.frame).toWorld(lon, lat);
    const c = Math.floor((x + p.frame.widthM / 2) / h.cell);
    const r = Math.floor((p.frame.heightM / 2 - y) / h.cell);
    if (c < 0 || r < 0 || c >= h.width || r >= h.height) return "";
    const i = r * h.width + c;
    const z = h.z[i];
    const w = h.w[i];
    if (w === WATER_SEA) return `Mer · ${m(z)}`;
    if (w === WATER_LAKE) return `Lac · ${m(z)}`;
    if (w === WATER_RIVER) return `Rivière · ${m(z)}`;
    const realZ = z / p.frame.verticalScale + p.stats.refHeight;
    return `${m(z)} dans le jeu (≈ ${m(realZ)} réels) · ${COVER_LABELS[h.c[i]] ?? ""}`;
  }

  /** The marker of the open sheet, if it is still there. */
  const sheetMarker = $derived.by(() => {
    if (!sheet || !preview) return null;
    if (sheet.town) {
      const c = preview.candidates?.find((x) => x.key === sheet!.town);
      return c ? { status: c.status, details: townDetails(c, preview.towns.find((t) => t.key === c.key)) } : null;
    }
    const c = preview.industryCandidates?.find((x) => x.key === sheet!.industry);
    return c ? { status: c.status, details: industryDetails(c) as MarkerDetails } : null;
  });

  function toggleSheet(): void {
    if (sheet?.town) onToggleTown?.(sheet.town);
    else if (sheet?.industry) onToggleIndustry?.(sheet.industry);
  }

  function closeSheet(): void {
    sheet = null;
    popup?.setPosition(undefined);
  }

  /** Fit the view on the area. */
  export function fit(): void {
    if (!map) return;
    const ext = source.getExtent();
    if (ext && Number.isFinite(ext[0])) map.getView().fit(ext, { padding: [40, 40, 40, 40], duration: 300 });
  }

  onMount(() => {
    popup = new Overlay({ element: popupEl, positioning: "bottom-center", offset: [0, -14], stopEvent: true });
    map = new Map({
      target: el,
      layers: [new TileLayer({ source: new OSM() }), imageLayer, realLayer, networkLayer, new VectorLayer({ source }), markerLayer, ghostLayer],
      overlays: [popup],
      view: new View({ center: fromLonLat([frame.area.lon, frame.area.lat]), zoom: 10 }),
    });
    map.on("singleclick", (ev) => {
      // Ctrl + click: the area moves there.
      if ((ev.originalEvent as MouseEvent).ctrlKey) {
        const [lon, lat] = toLonLat(ev.coordinate);
        onPick(lon, lat);
        return;
      }
      const k = keyAt(ev.pixel);
      if (k.town || k.industry) {
        sheet = k.town ? { town: k.town } : { industry: k.industry };
        popup?.setPosition(ev.coordinate);
      } else closeSheet();
    });
    // Ctrl held: the ghost follows the mouse; released: it goes away.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey === ctrl) return;
      ctrl = ev.ctrlKey;
      showGhost(ctrl ? lastPixel : null);
      el.style.cursor = ctrl ? "crosshair" : "";
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    const onBlur = () => {
      ctrl = false;
      showGhost(null);
    };
    window.addEventListener("blur", onBlur);
    const onContext = (ev: MouseEvent) => {
      ev.preventDefault();
      if (!map) return;
      const k = keyAt(map.getEventPixel(ev));
      if (k.town) onToggleTown?.(k.town);
      else if (k.industry) onToggleIndustry?.(k.industry);
    };
    el.addEventListener("contextmenu", onContext);
    map.on("pointermove", (ev) => {
      lastPixel = ev.pixel;
      const held = (ev.originalEvent as PointerEvent).ctrlKey;
      if (held !== ctrl) {
        ctrl = held;
        el.style.cursor = ctrl ? "crosshair" : "";
      }
      if (ctrl) {
        showGhost(ev.pixel);
        tip = "Clic : placer la zone ici";
        return;
      }
      const k = keyAt(ev.pixel);
      const town = k.town ? preview?.candidates?.find((x) => x.key === k.town) : undefined;
      const ind = k.industry ? preview?.industryCandidates?.find((x) => x.key === k.industry) : undefined;
      const status = town?.status ?? ind?.status;
      const marker = town ? townTitle(town) : ind ? industryTitle(ind) : "";
      const [lon, lat] = toLonLat(ev.coordinate);
      tip = marker ? `${marker} — clic : détails · clic droit : ${status === "off" ? "ajouter" : "retirer"}` : (k.tip ?? describe(lon, lat));
      el.style.cursor = town || ind ? "pointer" : "";
    });
    el.addEventListener("pointerleave", () => {
      tip = "";
      lastPixel = null;
      showGhost(null);
    });
    draw(frame);
    fit();
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      el.removeEventListener("contextmenu", onContext);
      map?.setTarget(undefined);
    };
  });

  $effect(() => draw(frame));
  $effect(() => showPreview(preview, hideOff));
  $effect(() => showReal(real));
  $effect(() => showNetwork(preview, linkPicks));
  $effect(() => {
    const game = view === "game";
    imageLayer.setVisible(game);
    markerLayer.setVisible(game);
    networkLayer.setVisible(game);
    realLayer.setVisible(!game);
    if (!game) closeSheet();
  });
  $effect(() => imageLayer.setOpacity(opacity));
  // A marker that disappears (new area, new data) closes its sheet.
  $effect(() => {
    if (sheet && !sheetMarker) closeSheet();
  });
</script>

<div class="wrap">
  <div class="map" bind:this={el}></div>
  <div class="popup" class:open={!!sheetMarker} bind:this={popupEl}>
    {#if sheetMarker}
      {@const d = sheetMarker.details}
      <button class="close" title="Fermer" onclick={closeSheet}>×</button>
      <h4>{d.title}</h4>
      <ul>
        {#each d.lines as line, i (i)}<li>{line}</li>{/each}
      </ul>
      <button class="small" onclick={toggleSheet}>{sheetMarker.status === "off" ? "Ajouter à la carte" : "Retirer de la carte"}</button>
    {/if}
  </div>
  {#if tip}<div class="tip">{tip}</div>{/if}
  {#if preview && view === "game"}
    <div class="legend">
      <button class="link" onclick={() => (legendOpen = !legendOpen)}>{legendOpen ? "Masquer la légende" : "Légende"}</button>
      {#if legendOpen}
        <ul>
          <li><i style:background={rgb(WATER_RGB)}></i>Eau (sous le niveau 0)</li>
          {#each COVER_LABELS as label, i (label)}
            <li><i style:background={rgb(COVER_RGB[i])}></i>{label}</li>
          {/each}
          <li><i class="dot" style:background={TOWN_COLORS.placed}></i>Ville (taille selon la population)</li>
          <li><i class="dot" style:background={TOWN_COLORS.off}></i>Lieu non retenu</li>
          <li><i class="dot" style:background={TOWN_COLORS.dropped}></i>Retenu mais non placé</li>
          <li><i class="dash"></i>Ville déplacée depuis sa position réelle</li>
          <li><i class="sq" style:background={INDUSTRY_COLORS.primary}></i>Industrie primaire (champs, mines, forêts)</li>
          <li><i class="sq" style:background={INDUSTRY_COLORS.factory}></i>Usine</li>
          <li><i class="sq" style:background={INDUSTRY_COLORS.water}></i>Industrie sur l'eau</li>
          <li><i class="line road"></i>Liaison routière (pointillés : pas de route réelle)</li>
          <li><i class="line rail"></i>Voie ferrée principale</li>
        </ul>
        <p>Ctrl + clic : placer la zone · clic : détails · clic droit : ajouter / retirer</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .map {
    width: 100%;
    height: 100%;
  }
  .tip {
    position: absolute;
    left: 10px;
    bottom: 10px;
    max-width: 60%;
    background: rgba(255, 255, 255, 0.94);
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 12px;
    pointer-events: none;
  }
  .popup {
    display: none;
    position: relative;
    min-width: 220px;
    max-width: 320px;
    background: #fff;
    border: 1px solid #c3c9d0;
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    font-size: 12px;
  }
  .popup.open {
    display: block;
  }
  .popup h4 {
    margin: 8px 24px 4px 10px;
    font-size: 13px;
  }
  .popup ul {
    margin: 0;
    padding: 0 10px 0 24px;
  }
  .popup .close {
    position: absolute;
    top: 2px;
    right: 4px;
    border: none;
    background: none;
    font-size: 16px;
    cursor: pointer;
    color: #5b6670;
  }
  .popup .small {
    margin: 6px 10px 8px;
  }
  .legend {
    position: absolute;
    right: 10px;
    bottom: 24px;
    max-width: 260px;
    background: rgba(255, 255, 255, 0.94);
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 12px;
  }
  .legend ul {
    list-style: none;
    margin: 4px 0;
    padding: 0;
  }
  .legend li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .legend p {
    margin: 4px 0 0;
    color: #5b6670;
  }
  .legend i {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 2px;
    flex: none;
  }
  .legend i.dot {
    border-radius: 50%;
  }
  .legend i.sq {
    width: 9px;
    height: 9px;
    transform: rotate(45deg);
  }
  .legend i.line {
    height: 0;
    border-radius: 0;
  }
  .legend i.line.road {
    border-top: 3px solid #8b5a2b;
  }
  .legend i.line.rail {
    border-top: 4px solid #1d2329;
  }
  .legend i.dash {
    height: 0;
    border-top: 2px dashed #c82828;
  }
  button.link {
    border: none;
    background: none;
    padding: 0;
    color: #2a6fdb;
    cursor: pointer;
    font-size: 12px;
    text-decoration: underline;
  }
</style>
