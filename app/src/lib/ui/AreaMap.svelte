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
   * Ctrl held: a ghost of the area follows the mouse; Ctrl + click moves the area there. The centre
   * is a handle: pressed and dragged, it turns the area (its top points to the mouse; Shift: 15°
   * steps). Click on a
   * town / industry: its sheet. Right click: a menu (add / remove a town or an industry, add an
   * industry here, a road to another town, a railway line to another point; the next click picks
   * the other end, Escape cancels). Hover: what is under the cursor in the game (height, water,
   * land cover).
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
  import { addCoordinateTransforms, addProjection, fromLonLat, get as getProjection, toLonLat } from "ol/proj";
  import Projection from "ol/proj/Projection";
  import PointerInteraction from "ol/interaction/Pointer";
  import { Fill, Icon, RegularShape, Stroke, Style, Circle as CircleStyle } from "ol/style";
  import { frameOutline, frameProjection, makeFrame, roundRotation, TILE_M, type Frame } from "$lib/core/area";
  import { b64ToBytes, b64ToFloats } from "$lib/core/b64";
  import { fmtNum, t, tk } from "$lib/i18n/index.svelte";
  import { COVER_RGB, WATER_RGB } from "$lib/core/preview";
  import { WATER_LAKE, WATER_RIVER, WATER_SEA } from "$lib/core/terrain";
  import type { PreviewState, RealLayer } from "$lib/state/importer.svelte";
  import {
    INDUSTRY_COLORS, TOWN_COLORS, industryColor, industryDetails, industryFeature, industryTitle, shownTownKeys, townDetails, townFeature,
    townTitle, type MarkerDetails,
  } from "./townMarkers";
  import { industryLabel } from "./townMarkers";

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
    industryTypes = [],
    onAddIndustry,
    onAddRoad,
    onAddRail,
    onLink,
    onRotate,
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
    /** Industry types offered by « Ajouter une industrie ». */
    industryTypes?: { tag: string; label: string }[];
    onAddIndustry?: (tag: string, lon: number, lat: number) => void;
    /** A road between two towns (town keys). */
    onAddRoad?: (from: string, to: string) => void;
    /** A railway line between two points (lon / lat). */
    onAddRail?: (from: [number, number], to: [number, number]) => void;
    /** Remove a road link / railway line (or put it back when it was left out). */
    onLink?: (key: string) => void;
    /** The area turned with the centre handle (degrees clockwise from north). */
    onRotate?: (deg: number) => void;
  } = $props();

  /** The right-click menu: where (pixel in the map), what is there (lon / lat, town, industry). */
  let menu = $state<{ x: number; y: number; lon: number; lat: number; town?: string; industry?: string; link?: string; linkName?: string } | null>(null);
  let menuIndustries = $state(false);
  /** Waiting for the other end of a road (from a town) or a railway line (from a point). */
  let pending = $state<{ kind: "road"; town: string; name: string } | { kind: "rail"; from: [number, number] } | null>(null);

  function closeMenu(): void {
    menu = null;
    menuIndustries = false;
  }
  function menuAction(fn: () => void): void {
    fn();
    closeMenu();
  }
  const statusOf = (k: { town?: string; industry?: string }) =>
    k.town ? preview?.candidates?.find((x) => x.key === k.town)?.status : preview?.industryCandidates?.find((x) => x.key === k.industry)?.status;

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
  /** While the handle is dragged: the angle shown (degrees) and where to show it. */
  let turning = $state<{ deg: number; x: number; y: number } | null>(null);

  function onHandle(pixel: number[]): boolean {
    if (!map) return false;
    const c = map.getPixelFromCoordinate(fromLonLat([frame.area.lon, frame.area.lat]));
    return !!c && Math.hypot(pixel[0] - c[0], pixel[1] - c[1]) <= HANDLE_PX;
  }

  /** Bearing (degrees clockwise from north) from the centre to a pixel, to the tenth; Shift: 15° steps. */
  function bearingTo(pixel: number[], shift: boolean): number {
    const c = map!.getPixelFromCoordinate(fromLonLat([frame.area.lon, frame.area.lat]));
    const deg = (Math.atan2(pixel[0] - c[0], c[1] - pixel[1]) * 180) / Math.PI;
    const step = shift ? 150 : 1;
    return roundRotation(Math.round((deg * 10) / step) * step / 10);
  }

  const rotateInteraction = new PointerInteraction({
    handleDownEvent: (ev) => {
      const e = ev.originalEvent as PointerEvent;
      if (e.ctrlKey || e.button !== 0 || pending || !onRotate || !onHandle(ev.pixel)) return false;
      closeMenu();
      el.style.cursor = "grabbing";
      return true;
    },
    handleDragEvent: (ev) => {
      const deg = bearingTo(ev.pixel, (ev.originalEvent as PointerEvent).shiftKey);
      turning = { deg, x: ev.pixel[0], y: ev.pixel[1] };
      draw(makeFrame({ ...frame.area, rotation: deg }));
    },
    handleUpEvent: () => {
      el.style.cursor = "";
      if (turning) onRotate?.(turning.deg);
      turning = null;
      return false;
    },
  });

  const outlineStyle = new Style({
    stroke: new Stroke({ color: "#FD9401", width: 2 }),
    fill: new Fill({ color: "rgba(253, 148, 1, 0.06)" }),
  });
  const gridStyle = new Style({ stroke: new Stroke({ color: "rgba(253, 148, 1, 0.3)", width: 1 }) });
  /**
   * The centre handle: an orange disc with a turning arrow, its notch on the map's top edge side.
   * The arrow is Lucide's `rotate-cw` (lucide-static 0.460.0, ISC License, © Lucide Contributors).
   */
  const HANDLE_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>" +
    "<path d='M16 0.8 L20.5 6.5 L11.5 6.5 Z' fill='#FD9401' stroke='#fff' stroke-width='1.3' stroke-linejoin='round'/>" +
    "<circle cx='16' cy='18' r='11.5' fill='#FD9401' stroke='#fff' stroke-width='2'/>" +
    "<g transform='translate(9.25 11.25) scale(0.5625)' fill='none' stroke='#fff' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'>" +
    "<path d='M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8'/><path d='M21 3v5h-5'/></g>" +
    "</svg>";
  const handleStyle = (rot: number) =>
    new Style({
      image: new Icon({ src: `data:image/svg+xml;utf8,${encodeURIComponent(HANDLE_SVG)}`, anchor: [0.5, 18 / 32], rotation: rot }),
      zIndex: 10,
    });
  /** Within this many pixels of the centre, the pointer is on the handle. */
  const HANDLE_PX = 15;
  const shiftStyle = new Style({ stroke: new Stroke({ color: "#c82828", width: 2, lineDash: [6, 4] }) });
  const rawWater = new Style({ stroke: new Stroke({ color: "#1565c0", width: 2 }), fill: new Fill({ color: "rgba(21, 101, 192, 0.35)" }), zIndex: 1 });
  const rawPlace = new Style({ image: new CircleStyle({ radius: 3, fill: new Fill({ color: "#2e9d4a" }), stroke: new Stroke({ color: "#fff", width: 1 }) }) });
  const rawSite = (tag: string) =>
    new Style({ image: new RegularShape({ points: 4, radius: 5, angle: Math.PI / 4, fill: new Fill({ color: industryColor(tag) }), stroke: new Stroke({ color: "#fff", width: 1 }) }) });
  const ghostStyle = new Style({
    stroke: new Stroke({ color: "#FD9401", width: 2, lineDash: [8, 6] }),
    fill: new Fill({ color: "rgba(253, 148, 1, 0.1)" }),
  });
  // A planned link, straight from town to town (the game routes the road): pale and dashed when off.
  const linkStyle = (on: boolean) =>
    new Style({ stroke: new Stroke({ color: on ? "#8b5a2b" : "rgba(139, 90, 43, 0.35)", width: on ? 3 : 2, lineDash: on ? undefined : [6, 5] }) });
  const railStyle = (on: boolean) => [
    new Style({ stroke: new Stroke({ color: on ? "#1d2329" : "rgba(29, 35, 41, 0.35)", width: 4 }) }),
    new Style({ stroke: new Stroke({ color: "#fff", width: 2, lineDash: [8, 8] }) }),
  ];
  // Bridge: the track on a wide white deck edged in black (like a map's bridge); tunnel: a dotted
  // track on a pale band. No blue: it read as water.
  const bridgeStyle = [
    new Style({ stroke: new Stroke({ color: "#1d2329", width: 12, lineCap: "butt" }), zIndex: 2 }),
    new Style({ stroke: new Stroke({ color: "#fff", width: 8, lineCap: "butt" }), zIndex: 2 }),
    new Style({ stroke: new Stroke({ color: "#1d2329", width: 3, lineCap: "butt" }), zIndex: 2 }),
  ];
  const tunnelStyle = [
    new Style({ stroke: new Stroke({ color: "rgba(255, 255, 255, 0.85)", width: 10, lineCap: "butt" }), zIndex: 2 }),
    new Style({ stroke: new Stroke({ color: "#3d4851", width: 3, lineDash: [3, 5], lineCap: "butt" }), zIndex: 2 }),
  ];
  const rawRoad = new Style({ stroke: new Stroke({ color: "rgba(139, 90, 43, 0.6)", width: 1.5 }), zIndex: 2 });
  const rawRail = new Style({ stroke: new Stroke({ color: "#1d2329", width: 2.5 }), zIndex: 3 });
  const rgb = (c: [number, number, number]) => `rgb(${c.join(",")})`;
  const m = (x: number) => `${fmtNum(x, 1)} m`;
  /** Land-cover classes of the legend and the hover text. */
  const COVERS = [0, 1, 2, 3];

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
    centre.setStyle(handleStyle(f.rot));
    source.addFeature(centre);
  }

  /**
   * The game map's own coordinates (game metres, possibly turned) as an OpenLayers projection, so
   * the preview image is reprojected onto the background map; registered once per frame.
   */
  function gameProjection(f: Frame): Projection {
    const code = `ICITY:${f.area.lon},${f.area.lat},${f.rot},${f.scale},${f.widthM},${f.heightM}`;
    const known = getProjection(code);
    if (known) return known;
    const proj = new Projection({ code, units: "m", extent: [-f.widthM / 2, -f.heightM / 2, f.widthM / 2, f.heightM / 2] });
    addProjection(proj);
    const fp = frameProjection(f);
    addCoordinateTransforms(
      proj,
      "EPSG:3857",
      (c) => fromLonLat(fp.toLonLat(c[0], c[1])),
      (c) => fp.toWorld(...(toLonLat(c) as [number, number])),
    );
    return proj;
  }

  function showPreview(p: PreviewState | null, hide: boolean): void {
    markerSource.clear();
    if (!p) {
      imageLayer.setSource(null);
      return;
    }
    const f = p.frame;
    const hx = f.widthM / 2;
    const hy = f.heightM / 2;
    imageLayer.setSource(new ImageStatic({ url: p.url, projection: gameProjection(f), imageExtent: [-hx, -hy, hx, hy], interpolate: true }));
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
      const feat = new Feature(new LineString([fromLonLat(ll[0]), fromLonLat(ll[ll.length - 1])]));
      feat.setStyle(linkStyle(picks[l.key] !== false));
      feat.set("linkKey", l.key);
      feat.set("linkRoad", [l.a, l.b]);
      networkSource.addFeature(feat);
    }
    for (const r of net.rail) {
      const ll = net.ll[r.key];
      if (!ll) continue;
      const on = picks[r.key] !== false;
      const feat = new Feature(new LineString(ll.map((pt) => fromLonLat(pt))));
      feat.setStyle(railStyle(on));
      feat.set("linkKey", r.key);
      feat.set("linkRail", r.key.startsWith("rail:user:") ? "" : (r.name ?? ""));
      networkSource.addFeature(feat);
      // Bridges and tunnels of the designed alignment, over the line.
      (r.nodes ?? []).forEach((p, i) => {
        if (p.kind === "n" || !ll[i + 1]) return;
        const seg = new Feature(new LineString([fromLonLat(ll[i]), fromLonLat(ll[i + 1])]));
        seg.setStyle(p.kind === "b" ? bridgeStyle : tunnelStyle);
        seg.set("structure", p.kind);
        seg.set("linkKey", r.key);
        seg.set("linkRail", r.key.startsWith("rail:user:") ? "" : (r.name ?? ""));
        networkSource.addFeature(seg);
      });
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
      feat.set("tip", `${w.kind === "rail" ? t("map.realRail") : t("map.realRoad")} ${w.cls}${w.name ? ` · ${w.name}` : ""}`);
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
      feat.set("tip", `${pl.name} (${tk(`place.${pl.place}`)}${pl.population ? `, ${t("sheet.inhabitants", { n: fmtNum(pl.population) })}` : ""})`);
      realSource.addFeature(feat);
    }
    for (const s of r.sites) {
      const feat = new Feature(new Point(fromLonLat([s.lon, s.lat])));
      feat.setStyle(rawSite(s.tag));
      feat.set("tip", `${s.name ? `${s.name} · ` : ""}${s.why} → ${s.tag}`);
      realSource.addFeature(feat);
    }
  }

  function keyAt(pixel: number[]): { town?: string; industry?: string; link?: string; linkName?: string; tip?: string } {
    return (
      map?.forEachFeatureAtPixel(
        pixel,
        (f) => {
          if (f.get("townKey")) return { town: f.get("townKey") as string };
          if (f.get("industryKey")) return { industry: f.get("industryKey") as string };
          if (f.get("linkKey") && view === "game") {
            const road = f.get("linkRoad") as [string, string] | undefined;
            const name = road ? t("map.road", { a: road[0], b: road[1] }) : (f.get("linkRail") as string) || t("map.railLine");
            const st = f.get("structure") as string | undefined;
            const what = st === "b" ? `${t("map.bridge")} · ` : st === "t" ? `${t("map.tunnel")} · ` : "";
            return { link: f.get("linkKey") as string, linkName: name, tip: t("map.linkTip", { name: what + name }) };
          }
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
    if (w === WATER_SEA) return t("map.sea", { z: m(z) });
    if (w === WATER_LAKE) return t("map.lake", { z: m(z) });
    if (w === WATER_RIVER) return t("map.river", { z: m(z) });
    const realZ = z / p.frame.verticalScale + p.stats.refHeight;
    return t("map.ground", { z: m(z), real: m(realZ), cover: tk(`cover.${h.c[i]}`) });
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

  /**
   * Centre the map on a town or an industry and open its sheet (from the lists panel); `insetPx`
   * of the map on the left is covered (the panel), so the marker goes in the middle of the rest.
   */
  export function focus(kind: "town" | "industry", key: string, insetPx = 0): void {
    if (!map || !preview) return;
    const c = kind === "town" ? preview.candidates?.find((x) => x.key === key) : preview.industryCandidates?.find((x) => x.key === key);
    if (!c) return;
    const at = fromLonLat([c.lon, c.lat]);
    const view = map.getView();
    const zoom = Math.max(view.getZoom() ?? 12, 12);
    const width = map.getSize()?.[0] ?? 0;
    const shift = width > insetPx * 1.5 ? (insetPx / 2) * view.getResolutionForZoom(zoom) : 0;
    view.animate({ center: [at[0] - shift, at[1]], zoom, duration: 300 });
    sheet = kind === "town" ? { town: key } : { industry: key };
    popup?.setPosition(at);
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
    map.addInteraction(rotateInteraction);
    map.on("singleclick", (ev) => {
      // Ctrl + click: the area moves there.
      if ((ev.originalEvent as MouseEvent).ctrlKey) {
        const [lon, lat] = toLonLat(ev.coordinate);
        onPick(lon, lat);
        return;
      }
      const k = keyAt(ev.pixel);
      if (menu) {
        closeMenu();
        return;
      }
      // The other end of a road or a railway line started from the menu.
      if (pending) {
        const [lon, lat] = toLonLat(ev.coordinate);
        if (pending.kind === "road") {
          if (k.town && k.town !== pending.town) {
            onAddRoad?.(pending.town, k.town);
            pending = null;
          } else tip = t("map.otherTown");
        } else {
          const town = k.town ? preview?.candidates?.find((x) => x.key === k.town) : undefined;
          onAddRail?.(pending.from, town ? [town.lon, town.lat] : [lon, lat]);
          pending = null;
        }
        return;
      }
      if (k.town || k.industry) {
        sheet = k.town ? { town: k.town } : { industry: k.industry };
        popup?.setPosition(ev.coordinate);
      } else closeSheet();
    });
    // Ctrl held: the ghost follows the mouse; released: it goes away.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && (pending || menu)) {
        pending = null;
        closeMenu();
      }
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
      const pixel = map.getEventPixel(ev);
      const k = keyAt(pixel);
      const [lon, lat] = toLonLat(map.getCoordinateFromPixel(pixel));
      const town = k.town ? preview?.candidates?.find((x) => x.key === k.town) : undefined;
      const ind = k.industry ? preview?.industryCandidates?.find((x) => x.key === k.industry) : undefined;
      // A town or an industry snaps the point to it.
      const at = town ?? ind;
      pending = null;
      closeSheet();
      menu = { x: pixel[0], y: pixel[1], lon: at?.lon ?? lon, lat: at?.lat ?? lat, town: k.town, industry: k.industry, link: k.link, linkName: k.linkName };
      menuIndustries = false;
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
        tip = t("map.placeHere");
        return;
      }
      if (pending) {
        tip = `${pending.kind === "road" ? t("map.roadFrom", { name: pending.name }) : t("map.railFrom")} ${t("map.escape")}`;
        return;
      }
      if (onRotate && onHandle(ev.pixel)) {
        tip = t("map.rotateTip", { deg: fmtNum(roundRotation(frame.area.rotation), 1) });
        el.style.cursor = "grab";
        return;
      }
      const k = keyAt(ev.pixel);
      const town = k.town ? preview?.candidates?.find((x) => x.key === k.town) : undefined;
      const ind = k.industry ? preview?.industryCandidates?.find((x) => x.key === k.industry) : undefined;
      const status = town?.status ?? ind?.status;
      const marker = town ? townTitle(town) : ind ? industryTitle(ind) : "";
      const [lon, lat] = toLonLat(ev.coordinate);
      tip = marker ? t("map.markerTip", { marker, action: status === "off" ? t("map.add") : t("map.remove") }) : (k.tip ?? describe(lon, lat));
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
      <button class="close" title={t("sheet.close")} onclick={closeSheet}>×</button>
      <h4>{d.title}</h4>
      <ul>
        {#each d.lines as line, i (i)}<li>{line}</li>{/each}
      </ul>
      <button class="small" onclick={toggleSheet}>{sheetMarker.status === "off" ? t("sheet.addToMap") : t("sheet.removeFromMap")}</button>
    {/if}
  </div>
  {#if tip}<div class="tip">{tip}</div>{/if}
  {#if turning}<div class="angle" style:left="{turning.x + 14}px" style:top="{turning.y - 28}px">{fmtNum(turning.deg, 1)}°</div>{/if}
  {#if pending}
    <div class="banner">
      {pending.kind === "road" ? t("map.roadFrom", { name: pending.name }) : t("map.railFrom")}
      <button class="link" onclick={() => (pending = null)}>{t("map.cancel")}</button>
    </div>
  {/if}
  {#if menu}
    {@const m = menu}
    {@const st = statusOf(m)}
    <div class="menu" style:left="{m.x}px" style:top="{m.y}px" role="menu">
      {#if m.town}
        <button onclick={() => menuAction(() => onToggleTown?.(m.town!))}>{st === "off" ? t("menu.addTown") : t("menu.removeTown")}</button>
        {#if st === "placed"}
          <button onclick={() => menuAction(() => { const name = preview?.candidates?.find((x) => x.key === m.town)?.name ?? ""; pending = { kind: "road", town: m.town!, name }; })}>{t("menu.roadTo")}</button>
        {/if}
      {:else if m.industry}
        <button onclick={() => menuAction(() => onToggleIndustry?.(m.industry!))}>{st === "off" ? t("menu.addIndustryHere") : t("menu.removeIndustry")}</button>
      {:else if m.link}
        {@const isRail = m.link.startsWith("rail:")}
        {@const off = linkPicks[m.link] === false}
        <p class="what">{m.linkName}</p>
        <button onclick={() => menuAction(() => onLink?.(m.link!))}>{off ? t(isRail ? "menu.restoreRail" : "menu.restoreRoad") : t(isRail ? "menu.removeRail" : "menu.removeRoad")}</button>
      {/if}
      {#if preview}
        <button onclick={() => menuAction(() => (pending = { kind: "rail", from: [m.lon, m.lat] }))}>{t("menu.railFrom")}</button>
        {#if !m.town && !m.industry && !m.link}
          <button class="sub" onclick={() => (menuIndustries = !menuIndustries)}>{t("menu.addIndustry")} {menuIndustries ? "▾" : "▸"}</button>
          {#if menuIndustries}
            <div class="types">
              {#each industryTypes as it (it.tag)}
                <button onclick={() => menuAction(() => onAddIndustry?.(it.tag, m.lon, m.lat))}>{industryLabel(it.tag)}</button>
              {/each}
            </div>
          {/if}
        {/if}
      {:else}
        <p>{t("menu.needResult")}</p>
      {/if}
    </div>
  {/if}
  {#if preview && view === "game"}
    <div class="legend">
      <button class="link" onclick={() => (legendOpen = !legendOpen)}>{legendOpen ? t("legend.hide") : t("legend.show")}</button>
      {#if legendOpen}
        <ul>
          <li><i style:background={rgb(WATER_RGB)}></i>{t("legend.water")}</li>
          {#each COVERS as i (i)}
            <li><i style:background={rgb(COVER_RGB[i])}></i>{tk(`cover.${i}`)}</li>
          {/each}
          <li><i class="dot" style:background={TOWN_COLORS.placed}></i>{t("legend.town")}</li>
          <li><i class="dot" style:background={TOWN_COLORS.off}></i>{t("legend.off")}</li>
          <li><i class="dot" style:background={TOWN_COLORS.dropped}></i>{t("legend.dropped")}</li>
          <li><i class="dash"></i>{t("legend.moved")}</li>
          <li><i class="sq" style:background={INDUSTRY_COLORS.primary}></i>{t("legend.primary")}</li>
          <li><i class="sq" style:background={INDUSTRY_COLORS.factory}></i>{t("legend.factory")}</li>
          <li><i class="sq" style:background={INDUSTRY_COLORS.water}></i>{t("legend.onWater")}</li>
          <li><i class="line road"></i>{t("legend.road")}</li>
          <li><svg width="28" height="12" aria-hidden="true"><line x1="0" y1="6" x2="28" y2="6" stroke="#1d2329" stroke-width="4" /><line x1="0" y1="6" x2="28" y2="6" stroke="#fff" stroke-width="2" stroke-dasharray="5 5" /></svg>{t("legend.rail")}</li>
          <li><svg width="28" height="12" aria-hidden="true"><line x1="0" y1="6" x2="28" y2="6" stroke="#1d2329" stroke-width="12" /><line x1="0" y1="6" x2="28" y2="6" stroke="#fff" stroke-width="8" /><line x1="0" y1="6" x2="28" y2="6" stroke="#1d2329" stroke-width="3" /></svg>{t("legend.bridge")}</li>
          <li><svg width="28" height="12" aria-hidden="true"><rect x="0" y="1" width="28" height="10" fill="#e9ecef" /><line x1="0" y1="6" x2="28" y2="6" stroke="#3d4851" stroke-width="3" stroke-dasharray="3 5" /></svg>{t("legend.tunnel")}</li>
        </ul>
        <p>{t("legend.help")}</p>
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
  .angle {
    position: absolute;
    z-index: 6;
    background: #1d2329;
    color: #fff;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 12px;
    pointer-events: none;
    white-space: nowrap;
  }
  .banner {
    position: absolute;
    left: 50%;
    bottom: 40px;
    transform: translateX(-50%);
    background: #1d2329;
    color: #fff;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    z-index: 6;
  }
  .banner button.link {
    color: #9cc3ff;
    margin-left: 8px;
  }
  .menu {
    position: absolute;
    z-index: 7;
    min-width: 200px;
    max-height: 60%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    background: #fff;
    border: 1px solid #c3c9d0;
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
    padding: 4px 0;
    font-size: 12px;
  }
  .menu button {
    border: none;
    background: none;
    text-align: left;
    padding: 5px 12px;
    font: inherit;
    cursor: pointer;
  }
  .menu button:hover {
    background: #f1f5fb;
  }
  .menu .types {
    display: flex;
    flex-direction: column;
    border-top: 1px solid #eef0f2;
    border-bottom: 1px solid #eef0f2;
    padding-left: 10px;
  }
  .menu p {
    margin: 4px 12px;
    color: #6b747c;
  }
  .menu p.what {
    font-weight: 600;
    color: #1d2329;
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
  .legend svg {
    flex: none;
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
