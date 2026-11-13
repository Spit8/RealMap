//! Lecture des extraits OpenStreetMap `.osm.pbf` (Geofabrik) pour les très grandes zones : les mêmes
//! éléments que les requêtes Overpass de l'app (eau, lieux, routes et rails, sites industriels,
//! plages et zones d'activité), écrits au format JSON d'Overpass (`out geom`, `out body geom`,
//! `out center tags`, `out bb tags`) pour que les analyseurs TypeScript restent inchangés.
//!
//! Une région à la fois, en trois passes (voies et relations retenues, voies membres des relations,
//! coordonnées des nœuds utiles) : la mémoire reste bornée par la région, pas par le pays.
//! Les géométries sont simplifiées (Douglas-Peucker itératif) à la tolérance de la carte, en gardant
//! les extrémités et les nœuds partagés des routes (carrefours du graphe).

use osmpbf::{Element, ElementReader, RelMemberType};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

/// Filtres envoyés par l'app (une seule source : les constantes TypeScript des requêtes Overpass).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Filters {
    /// `place=*` retenus (city, town, village), avec un `name`.
    pub place_kinds: Vec<String>,
    /// Classes `highway=*` (motorway, trunk, primary, secondary).
    pub road_classes: Vec<String>,
    /// Valeurs exactes de `industrial=*`.
    pub industrial: Vec<String>,
    /// Mots cherchés dans `product=*` (sous-chaîne, comme la regex Overpass non ancrée).
    pub product: Vec<String>,
    /// Périmètre minimal (m réels) des surfaces d'eau, comme `(if:length()>…)`.
    pub min_water_perimeter_m: f64,
    /// Tolérance de simplification (m réels), 0 = aucune.
    pub tolerance_m: f64,
}

#[derive(Deserialize, Clone, Copy)]
pub struct Bbox {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// Ce que chaque élément nourrit (un élément peut nourrir plusieurs requêtes).
#[derive(Clone, Copy, Default)]
struct Cats {
    water_area: bool,
    water_line: bool,
    road: bool,
    site: bool,
    beach: bool,
    business: bool,
}

impl Cats {
    fn any(&self) -> bool {
        self.water_area || self.water_line || self.road || self.site || self.beach || self.business
    }
}

fn tag<'a>(tags: &'a [(String, String)], k: &str) -> Option<&'a str> {
    tags.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.as_str())
}

/// Les filtres des requêtes Overpass (`overpassAreaQuery`, `overpassNetworkQuery`,
/// `overpassIndustryQuery`, `overpassLandQuery`), pour une voie (`is_way`) ou une relation.
fn classify(tags: &[(String, String)], f: &Filters, is_way: bool) -> Cats {
    let get = |k: &str| tag(tags, k);
    let mut c = Cats::default();
    let natural = get("natural").unwrap_or("");
    let waterway = get("waterway").unwrap_or("");
    let landuse = get("landuse").unwrap_or("");
    c.water_area = natural == "water" || waterway == "riverbank" || landuse == "reservoir";
    c.water_line = is_way && (waterway == "river" || waterway == "canal");
    if is_way {
        if let Some(h) = get("highway") {
            c.road = f.road_classes.iter().any(|r| r == h);
        }
        if get("railway") == Some("rail") {
            let usage = get("usage").unwrap_or("");
            let service = get("service").unwrap_or("");
            let bad_usage = ["tourism", "military", "industrial", "test"].contains(&usage);
            let bad_service = ["yard", "siding", "spur"].contains(&service);
            if !bad_usage && !bad_service {
                c.road = true;
            }
        }
    }
    c.site = is_site(tags, f);
    c.beach = matches!(natural, "beach" | "sand" | "dune");
    c.business = matches!(landuse, "commercial" | "retail" | "industrial");
    c
}

fn is_site(tags: &[(String, String)], f: &Filters) -> bool {
    let get = |k: &str| tag(tags, k);
    let landuse = get("landuse").unwrap_or("");
    let man_made = get("man_made").unwrap_or("");
    landuse == "quarry"
        || matches!(man_made, "petroleum_well" | "offshore_platform" | "mineshaft" | "adit" | "works")
        || get("industrial").is_some_and(|v| f.industrial.iter().any(|x| x == v))
        || matches!(get("craft"), Some("brewery") | Some("sawmill"))
        || get("product").is_some_and(|v| f.product.iter().any(|x| v.contains(x.as_str())))
        || (get("harbour") == Some("yes") && get("seamark:type").is_some_and(|v| v.contains("harbour")))
        || landuse == "port"
}

fn tags_of<'a>(it: impl Iterator<Item = (&'a str, &'a str)>) -> Vec<(String, String)> {
    it.map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

struct KeptWay {
    id: i64,
    refs: Vec<i64>,
    tags: Vec<(String, String)>,
    cats: Cats,
}

struct KeptRel {
    id: i64,
    /// (voie, rôle)
    members: Vec<(i64, String)>,
    tags: Vec<(String, String)>,
    cats: Cats,
}

/// Distance (m) entre deux points lon/lat (haversine), comme `length()` d'Overpass.
fn dist_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    let r = 6_371_008.8;
    let (la1, la2) = (a.1.to_radians(), b.1.to_radians());
    let dla = la2 - la1;
    let dlo = (b.0 - a.0).to_radians();
    let h = (dla / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlo / 2.0).sin().powi(2);
    2.0 * r * h.sqrt().asin()
}

fn length_m(pts: &[(f64, f64)]) -> f64 {
    pts.windows(2).map(|w| dist_m(w[0], w[1])).sum()
}

/// Douglas-Peucker itératif sur des points lon/lat ; `keep` vrai au départ = point imposé.
pub fn douglas_peucker(pts: &[(f64, f64)], tol_m: f64, keep: &mut [bool]) {
    let n = pts.len();
    if n < 3 || tol_m <= 0.0 {
        keep.iter_mut().for_each(|k| *k = true);
        return;
    }
    let kx = 111_320.0 * pts[0].1.to_radians().cos();
    let ky = 110_574.0;
    let x = |i: usize| pts[i].0 * kx;
    let y = |i: usize| pts[i].1 * ky;
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack: Vec<(usize, usize)> = Vec::new();
    let mut prev = 0;
    for (i, &k) in keep.iter().enumerate().skip(1) {
        if k {
            if i - prev > 1 {
                stack.push((prev, i));
            }
            prev = i;
        }
    }
    let tol2 = tol_m * tol_m;
    while let Some((a, b)) = stack.pop() {
        let (ax, ay, bx, by) = (x(a), y(a), x(b), y(b));
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let mut worst = usize::MAX;
        let mut worst_d = tol2;
        for i in a + 1..b {
            let (px, py) = (x(i) - ax, y(i) - ay);
            let d2 = if len2 == 0.0 {
                px * px + py * py
            } else {
                let t = ((px * dx + py * dy) / len2).clamp(0.0, 1.0);
                let (ex, ey) = (px - t * dx, py - t * dy);
                ex * ex + ey * ey
            };
            if d2 > worst_d {
                worst_d = d2;
                worst = i;
            }
        }
        if worst != usize::MAX {
            keep[worst] = true;
            if worst - a > 1 {
                stack.push((a, worst));
            }
            if b - worst > 1 {
                stack.push((worst, b));
            }
        }
    }
}

fn simplify(pts: &[(f64, f64)], tol_m: f64) -> Vec<(f64, f64)> {
    let mut keep = vec![false; pts.len()];
    douglas_peucker(pts, tol_m, &mut keep);
    let out: Vec<(f64, f64)> = pts.iter().zip(&keep).filter(|(_, k)| **k).map(|(p, _)| *p).collect();
    // Un anneau fermé garde au moins 4 points (sinon il reste tel quel).
    let closed = pts.len() >= 4 && pts[0] == pts[pts.len() - 1];
    if closed && out.len() < 4 {
        pts.to_vec()
    } else {
        out
    }
}

fn geom(pts: &[(f64, f64)]) -> Value {
    Value::Array(pts.iter().map(|(lon, lat)| json!({ "lat": lat, "lon": lon })).collect())
}

fn tags_json(tags: &[(String, String)]) -> Value {
    let mut m = Map::new();
    for (k, v) in tags {
        m.insert(k.clone(), Value::String(v.clone()));
    }
    Value::Object(m)
}

struct Box4 {
    w: f64,
    s: f64,
    e: f64,
    n: f64,
}

impl Box4 {
    fn empty() -> Self {
        Box4 { w: f64::INFINITY, s: f64::INFINITY, e: f64::NEG_INFINITY, n: f64::NEG_INFINITY }
    }
    fn add(&mut self, (lon, lat): (f64, f64)) {
        self.w = self.w.min(lon);
        self.e = self.e.max(lon);
        self.s = self.s.min(lat);
        self.n = self.n.max(lat);
    }
    fn touches(&self, b: &Bbox) -> bool {
        self.w <= b.east && self.e >= b.west && self.s <= b.north && self.n >= b.south
    }
    fn bounds(&self) -> Value {
        json!({ "minlat": self.s, "minlon": self.w, "maxlat": self.n, "maxlon": self.e })
    }
    fn center(&self) -> Value {
        json!({ "lat": (self.s + self.n) / 2.0, "lon": (self.w + self.e) / 2.0 })
    }
}

/// Réponses « Overpass » accumulées sur toutes les régions, sans doublon (`type/id`).
#[derive(Default)]
pub struct Output {
    pub area: Vec<Value>,
    pub places: Vec<Value>,
    pub roads: Vec<Value>,
    pub sites: Vec<Value>,
    pub land: Vec<Value>,
    seen: HashSet<(u8, u8, i64)>,
}

impl Output {
    /// `q` : requête (0 eau, 1 lieux, 2 routes, 3 sites, 4 sol), `t` : type (0 nœud, 1 voie, 2 relation).
    fn push(&mut self, q: u8, t: u8, id: i64, v: Value) {
        if !self.seen.insert((q, t, id)) {
            return;
        }
        match q {
            0 => self.area.push(v),
            1 => self.places.push(v),
            2 => self.roads.push(v),
            3 => self.sites.push(v),
            _ => self.land.push(v),
        }
    }

    pub fn to_json(&self) -> Value {
        let wrap = |v: &Vec<Value>| json!({ "elements": v });
        json!({
            "area": wrap(&self.area),
            "places": wrap(&self.places),
            "roads": wrap(&self.roads),
            "sites": wrap(&self.sites),
            "land": wrap(&self.land),
        })
    }
}

/// Avancement d'une région : passe 1 à 3, puis 4 (écriture).
pub type Progress<'a> = &'a dyn Fn(u8);

/// Lit une région et ajoute ses éléments à `out`.
pub fn extract_region(path: &str, bbox: &Bbox, f: &Filters, out: &mut Output, progress: Progress) -> Result<(), String> {
    let err = |e: osmpbf::Error| format!("{path}: {e}");

    // Passe 1 : voies et relations retenues.
    progress(1);
    type P1 = (Vec<KeptWay>, Vec<KeptRel>);
    let (ways, rels): P1 = ElementReader::from_path(path)
        .map_err(err)?
        .par_map_reduce(
            |el| match el {
                Element::Way(w) => {
                    let tags = tags_of(w.tags());
                    let cats = classify(&tags, f, true);
                    if cats.any() {
                        (vec![KeptWay { id: w.id(), refs: w.refs().collect(), tags, cats }], vec![])
                    } else {
                        (vec![], vec![])
                    }
                }
                Element::Relation(r) => {
                    let tags = tags_of(r.tags());
                    let cats = classify(&tags, f, false);
                    if cats.water_area || cats.beach || cats.business || cats.site {
                        let members = r
                            .members()
                            .filter(|m| m.member_type == RelMemberType::Way)
                            .map(|m| (m.member_id, m.role().unwrap_or("").to_string()))
                            .collect();
                        (vec![], vec![KeptRel { id: r.id(), members, tags, cats }])
                    } else {
                        (vec![], vec![])
                    }
                }
                _ => (vec![], vec![]),
            },
            || (vec![], vec![]),
            |mut a, b| {
                a.0.extend(b.0);
                a.1.extend(b.1);
                a
            },
        )
        .map_err(err)?;

    // Passe 2 : voies membres des relations (non retenues pour elles-mêmes).
    progress(2);
    let kept_ids: HashSet<i64> = ways.iter().map(|w| w.id).collect();
    let member_ids: HashSet<i64> = rels.iter().flat_map(|r| r.members.iter().map(|m| m.0)).filter(|id| !kept_ids.contains(id)).collect();
    let mut member_refs: HashMap<i64, Vec<i64>> = HashMap::new();
    if !member_ids.is_empty() {
        let found: Vec<(i64, Vec<i64>)> = ElementReader::from_path(path)
            .map_err(err)?
            .par_map_reduce(
                |el| match el {
                    Element::Way(w) if member_ids.contains(&w.id()) => vec![(w.id(), w.refs().collect())],
                    _ => vec![],
                },
                Vec::new,
                |mut a, b| {
                    a.extend(b);
                    a
                },
            )
            .map_err(err)?;
        member_refs.extend(found);
    }
    for w in &ways {
        member_refs.entry(w.id).or_insert_with(|| w.refs.clone());
    }

    // Passe 3 : coordonnées des nœuds utiles (identifiants triés), lieux et sites ponctuels.
    progress(3);
    let mut need: Vec<i64> = member_refs.values().flatten().copied().collect();
    need.sort_unstable();
    need.dedup();
    let place_kinds = &f.place_kinds;
    type P3 = (Vec<(usize, f64, f64)>, Vec<(i64, f64, f64, Vec<(String, String)>, bool, bool)>);
    let node = |id: i64, lat: f64, lon: f64, tags: Vec<(String, String)>| -> P3 {
        let mut hits = vec![];
        if let Ok(i) = need.binary_search(&id) {
            hits.push((i, lon, lat));
        }
        let mut pts = vec![];
        if !tags.is_empty() {
            let place = tag(&tags, "place").is_some_and(|p| place_kinds.iter().any(|k| k == p)) && tag(&tags, "name").is_some();
            let site = is_site(&tags, f);
            if place || site {
                pts.push((id, lat, lon, tags, place, site));
            }
        }
        (hits, pts)
    };
    let (hits, points): P3 = ElementReader::from_path(path)
        .map_err(err)?
        .par_map_reduce(
            |el| match el {
                Element::Node(n) => node(n.id(), n.lat(), n.lon(), tags_of(n.tags())),
                Element::DenseNode(n) => node(n.id(), n.lat(), n.lon(), tags_of(n.tags())),
                _ => (vec![], vec![]),
            },
            || (vec![], vec![]),
            |mut a, b| {
                a.0.extend(b.0);
                a.1.extend(b.1);
                a
            },
        )
        .map_err(err)?;
    let mut coords = vec![(f64::NAN, f64::NAN); need.len()];
    for (i, lon, lat) in hits {
        coords[i] = (lon, lat);
    }
    let at = |id: i64| need.binary_search(&id).ok().map(|i| coords[i]).filter(|p| p.0.is_finite());

    // Écriture au format Overpass.
    progress(4);
    for (id, lat, lon, tags, place, site) in points {
        if lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north {
            continue;
        }
        let v = json!({ "type": "node", "id": id, "lat": lat, "lon": lon, "tags": tags_json(&tags) });
        if place {
            out.push(1, 0, id, v.clone());
        }
        if site {
            out.push(3, 0, id, v);
        }
    }

    // Nœuds partagés entre routes / rails : sommets du graphe, toujours gardés.
    let mut uses: HashMap<i64, u32> = HashMap::new();
    for w in ways.iter().filter(|w| w.cats.road) {
        for r in &w.refs {
            *uses.entry(*r).or_default() += 1;
        }
    }
    let tol = f.tolerance_m;
    for w in &ways {
        // Nœuds absents de l'extrait (voie coupée au bord) : ignorés, comme Overpass ignore les nœuds hors données.
        let pairs: Vec<(i64, (f64, f64))> = w.refs.iter().filter_map(|r| at(*r).map(|p| (*r, p))).collect();
        if pairs.len() < 2 {
            continue;
        }
        let pts: Vec<(f64, f64)> = pairs.iter().map(|p| p.1).collect();
        let mut bx = Box4::empty();
        pts.iter().for_each(|p| bx.add(*p));
        if !bx.touches(bbox) {
            continue;
        }
        let tags = tags_json(&w.tags);
        if w.cats.water_line || (w.cats.water_area && length_m(&pts) > f.min_water_perimeter_m) {
            out.push(0, 1, w.id, json!({ "type": "way", "id": w.id, "geometry": geom(&simplify(&pts, tol)), "tags": tags }));
        }
        if w.cats.road {
            let mut keep: Vec<bool> = pairs.iter().map(|(r, _)| uses.get(r).copied().unwrap_or(0) > 1).collect();
            douglas_peucker(&pts, tol, &mut keep);
            let nodes: Vec<i64> = pairs.iter().zip(&keep).filter(|(_, k)| **k).map(|(p, _)| p.0).collect();
            let kept: Vec<(f64, f64)> = pts.iter().zip(&keep).filter(|(_, k)| **k).map(|(p, _)| *p).collect();
            out.push(2, 1, w.id, json!({ "type": "way", "id": w.id, "nodes": nodes, "geometry": geom(&kept), "tags": tags }));
        }
        if w.cats.site {
            out.push(3, 1, w.id, json!({ "type": "way", "id": w.id, "center": bx.center(), "tags": tags }));
        }
        if w.cats.beach {
            out.push(4, 1, w.id, json!({ "type": "way", "id": w.id, "geometry": geom(&simplify(&pts, tol)), "tags": tags }));
        }
        if w.cats.business {
            out.push(4, 1, w.id + (1 << 52), json!({ "type": "way", "id": w.id, "bounds": bx.bounds(), "tags": tags }));
        }
    }
    for r in &rels {
        let mut bx = Box4::empty();
        let mut length = 0.0;
        let mut members = vec![];
        for (way, role) in &r.members {
            let Some(refs) = member_refs.get(way) else { continue };
            let pts: Vec<(f64, f64)> = refs.iter().filter_map(|id| at(*id)).collect();
            if pts.len() < 2 {
                continue;
            }
            pts.iter().for_each(|p| bx.add(*p));
            length += length_m(&pts);
            members.push(json!({ "type": "way", "ref": way, "role": role, "geometry": geom(&simplify(&pts, tol)) }));
        }
        if members.is_empty() || !bx.touches(bbox) {
            continue;
        }
        let tags = tags_json(&r.tags);
        if r.cats.water_area && length > f.min_water_perimeter_m {
            out.push(0, 2, r.id, json!({ "type": "relation", "id": r.id, "members": members.clone(), "tags": tags }));
        }
        if r.cats.site {
            out.push(3, 2, r.id, json!({ "type": "relation", "id": r.id, "center": bx.center(), "tags": tags }));
        }
        if r.cats.beach {
            out.push(4, 2, r.id, json!({ "type": "relation", "id": r.id, "members": members, "tags": tags }));
        }
        if r.cats.business {
            out.push(4, 2, r.id + (1 << 52), json!({ "type": "relation", "id": r.id, "bounds": bx.bounds(), "tags": tags }));
        }
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtractProgress {
    /// 1 à 3 : passes de lecture, 4 : écriture.
    pub pass: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filters() -> Filters {
        Filters {
            place_kinds: vec!["city".into(), "town".into(), "village".into()],
            road_classes: vec!["motorway".into(), "trunk".into(), "primary".into(), "secondary".into()],
            industrial: vec!["brewery".into(), "sawmill".into()],
            product: vec!["beer".into(), "steel".into()],
            min_water_perimeter_m: 100.0,
            tolerance_m: 50.0,
        }
    }

    fn t(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn classifies_like_the_overpass_queries() {
        let f = filters();
        assert!(classify(&t(&[("highway", "primary")]), &f, true).road);
        assert!(!classify(&t(&[("highway", "residential")]), &f, true).road);
        assert!(classify(&t(&[("railway", "rail")]), &f, true).road);
        assert!(!classify(&t(&[("railway", "rail"), ("service", "yard")]), &f, true).road);
        assert!(!classify(&t(&[("railway", "rail"), ("usage", "tourism")]), &f, true).road);
        assert!(classify(&t(&[("natural", "water")]), &f, false).water_area);
        assert!(classify(&t(&[("waterway", "river")]), &f, true).water_line);
        assert!(!classify(&t(&[("waterway", "stream")]), &f, true).water_line);
        assert!(classify(&t(&[("product", "craft beer")]), &f, true).site);
        assert!(classify(&t(&[("harbour", "yes"), ("seamark:type", "harbour")]), &f, true).site);
        assert!(!classify(&t(&[("harbour", "yes")]), &f, true).site);
        assert!(classify(&t(&[("landuse", "retail")]), &f, true).business);
        assert!(classify(&t(&[("natural", "dune")]), &f, false).beach);
    }

    #[test]
    fn douglas_peucker_keeps_imposed_points_and_a_million_points() {
        let pts: Vec<(f64, f64)> = (0..1_000_000).map(|i| (19.0 + i as f64 * 1e-6, 52.0 + if i % 2 == 1 { 1e-6 } else { 0.0 })).collect();
        let mut keep = vec![false; pts.len()];
        keep[500_000] = true;
        douglas_peucker(&pts, 20.0, &mut keep);
        assert!(keep[0] && keep[999_999] && keep[500_000]);
        assert!(keep.iter().filter(|k| **k).count() < 10);
    }

    #[test]
    fn closed_rings_keep_four_points() {
        let ring = vec![(0.0, 0.0), (0.00001, 0.0), (0.00001, 0.00001), (0.0, 0.0)];
        assert_eq!(simplify(&ring, 1000.0).len(), 4);
    }
}

/// Oracle réel (lancé à la main) : `OSM_PBF=<extrait> OSM_BBOX=w,s,e,n OSM_OUT=<json> cargo test --lib oracle -- --ignored`.
/// La sortie se compare à la réponse d'Overpass sur la même zone (`test/geofabrik.live.ts`).
#[cfg(test)]
mod oracle {
    use super::*;

    #[test]
    #[ignore]
    fn oracle() {
        let path = std::env::var("OSM_PBF").expect("OSM_PBF");
        let b: Vec<f64> = std::env::var("OSM_BBOX").expect("OSM_BBOX").split(',').map(|x| x.parse().unwrap()).collect();
        let out_path = std::env::var("OSM_OUT").expect("OSM_OUT");
        let f: Filters = serde_json::from_str(&std::env::var("OSM_FILTERS").expect("OSM_FILTERS")).unwrap();
        let mut out = Output::default();
        let t0 = std::time::Instant::now();
        extract_region(&path, &Bbox { west: b[0], south: b[1], east: b[2], north: b[3] }, &f, &mut out, &|p| eprintln!("passe {p} à {:?}", t0.elapsed())).unwrap();
        std::fs::write(&out_path, serde_json::to_string(&out.to_json()).unwrap()).unwrap();
        eprintln!("eau {} lieux {} routes {} sites {} sol {} en {:?}", out.area.len(), out.places.len(), out.roads.len(), out.sites.len(), out.land.len(), t0.elapsed());
    }
}
