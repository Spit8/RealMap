-- Texts of the RealMap mod window and of the report it sends back to the app (DECISION-017). The
-- language follows the game (api.util.getLanguage), English otherwise. `en` and `fr` are written
-- by hand; other languages will be generated from `en` with their context (tools/i18n/README.md).
-- Every table keeps the %s / %d placeholders of `en`, in the same order (checked by
-- app/test/i18n.test.ts).

local M = {}

local STRINGS = {
	en = {
		hint_1 = "To generate a map: open a new empty map of the right size in the Map Editor,",
		hint_2 = "then click “Generate the map” in the RealMap app. Everything is built here, automatically.",
		title = "RealMap: “%s”",
		check = "Checking the open map…",
		err_not_editor = "Open the Map Editor: the map can only be generated in a new empty map of the Map Editor.",
		err_note_missing = "Map note not found (userdata/importcity/%s.lua).",
		err_map_size = "The open map is %d × %d tiles, %d × %d are needed (%s): create a new map of that size.",
		err_map_not_empty = "The open map already has towns or industries: create a new empty map.",
		err_heightmap_missing = "Heightmap “%s” not found in userdata/heightmaps.",
		err_biomes_missing = "Biomes “%s” not found in userdata/biomes.",
		err_no_generator = "No import generator for the climate of this map.",
		err_towns_missing = "Towns not found (userdata/towns_industries/%s.lua).",
		err_terrain_refused = "the game refused to replace the terrain",
		err_towns_refused = "the game refused to create the towns",
		warn_economy = "Warning: the map's economy is “%s”, the industries were planned for “%s”.",
		heightmap_importing = "Relief: importing “%s” (%d → %d m)…",
		heightmap_done = "Relief imported.",
		biomes_importing = "Biomes: “%s”…",
		biomes_done = "Biomes imported.",
		rail_building = "Railway: %d section(s)…",
		rail_done = "Railway: %d / %d section(s)%s%s%s.",
		rail_bridges = ", %d as bridges",
		rail_tunnels = ", %d in tunnels",
		rail_failed = "; %d refused%s, gaps near %s",
		rail_critical = "critical error",
		towns_done = "%d town(s) created, %d set to their real size.",
		industries_building = "Industries (%d)…",
		industries_done = "Industries built: %d, named: %d%s.",
		industries_missing = ", %d impossible",
		roads_building = "Roads: %d link(s) between towns…",
		roads_done = "%d road link(s)%s.",
		roads_partly = " (partly refused)",
		roads_simple = "%d / %d road segment(s) rebuilt as small country roads (2 lanes).",
		roads_access = "Industries linked by the game: %d / %d reach a road%s.",
		rail_crossings = "Railway: %d road crossing(s) passed under in a tunnel.",
		roads_access_missing = "; without a road nearby: %s",
		done = "Map “%s” generated. Save it (Map Editor menu).",
	},
	fr = {
		hint_1 = "Pour générer une carte : ouvre une nouvelle carte vide de la bonne taille dans l'éditeur de cartes,",
		hint_2 = "puis clique sur « Générer la carte » dans l'application RealMap. Tout se construit ici, automatiquement.",
		title = "RealMap : « %s »",
		check = "Vérification de la carte ouverte…",
		err_not_editor = "Ouvre l'éditeur de cartes : la génération ne se fait que dans une nouvelle carte vide de l'éditeur.",
		err_note_missing = "Note de la carte introuvable (userdata/importcity/%s.lua).",
		err_map_size = "La carte ouverte fait %d × %d tuiles, il en faut %d × %d (%s) : crée une nouvelle carte de cette taille.",
		err_map_not_empty = "La carte ouverte contient déjà des villes ou des industries : crée une nouvelle carte vide.",
		err_heightmap_missing = "Heightmap « %s » introuvable dans userdata/heightmaps.",
		err_biomes_missing = "Biomes « %s » introuvables dans userdata/biomes.",
		err_no_generator = "Aucun générateur d'import pour le climat de cette carte.",
		err_towns_missing = "Villes introuvables (userdata/towns_industries/%s.lua).",
		err_terrain_refused = "le jeu a refusé de remplacer le terrain",
		err_towns_refused = "le jeu a refusé de créer les villes",
		warn_economy = "Attention : économie de la carte « %s », industries prévues pour « %s ».",
		heightmap_importing = "Relief : import de « %s » (%d → %d m)…",
		heightmap_done = "Relief importé.",
		biomes_importing = "Biomes : « %s »…",
		biomes_done = "Biomes importés.",
		rail_building = "Voie ferrée : %d tronçon(s)…",
		rail_done = "Voie ferrée : %d / %d tronçon(s)%s%s%s.",
		rail_bridges = ", %d en pont",
		rail_tunnels = ", %d en tunnel",
		rail_failed = " ; %d refusé(s)%s, coupures vers %s",
		rail_critical = "erreur critique",
		towns_done = "%d ville(s) créée(s), %d mise(s) à leur taille réelle.",
		industries_building = "Industries (%d)…",
		industries_done = "%d industrie(s) posée(s), %d nommée(s)%s.",
		industries_missing = ", %d impossible(s)",
		roads_building = "Routes : %d liaison(s) entre villes…",
		roads_done = "%d liaison(s) routière(s)%s.",
		roads_partly = " (refusées en partie)",
		roads_simple = "%d / %d tronçon(s) de route refait(s) en petites routes de campagne (2 voies).",
		roads_access = "Industries reliées par le jeu : %d / %d ont une route%s.",
		rail_crossings = "Voie ferrée : %d croisement(s) de route passé(s) dessous en tunnel.",
		roads_access_missing = " ; sans route à proximité : %s",
		done = "Carte « %s » générée. Enregistre-la (menu de l'éditeur).",
	},
	-- BEGIN generated de (tools/i18n/import.mts)
	de = {
		hint_1 = "Um eine Karte zu erstellen: Öffne eine neue, leere Karte in der richtigen Grösse im Karten-Editor,",
		hint_2 = "Klicke dann auf \"Karte generieren\" in der RealMap-Anwendung. Alles wird hier automatisch erstellt.",
		title = "RealMap: „%s“",
		check = "Überprüfung der Karte…",
		err_not_editor = "Öffne den Karten-Editor: Die Karte kann nur in einer neuen, leeren Karte des Karten-Editors erstellt werden.",
		err_note_missing = "Die Kartenhinweisdatei konnte nicht gefunden werden (userdata/importcity/%s.lua).",
		err_map_size = "Die geöffnete Karte besteht aus %d × %d Kacheln, es werden %d × %d benötigt (%s): Erstelle eine neue Karte in dieser Grösse.",
		err_map_not_empty = "Die aktuell geladene Karte enthält bereits Städte oder Industrien: Erstelle eine neue, leere Karte.",
		err_heightmap_missing = "Die Heightmap „%s“ konnte nicht in userdata/heightmaps gefunden werden.",
		err_biomes_missing = "Die Biome „%s“ wurden nicht in userdata/biomes gefunden.",
		err_no_generator = "Es gibt keinen Importgenerator für das Klima dieser Karte.",
		err_towns_missing = "Städte nicht gefunden (userdata/towns_industries/%s.lua).",
		err_terrain_refused = "Das Spiel hat die Änderung des Geländes abgelehnt",
		err_towns_refused = "Das Spiel hat die Erstellung der Städte abgelehnt",
		warn_economy = "Achtung: Die Wirtschaft der Karte ist \"%s\", die Industrien sind für \"%s\" vorgesehen.",
		heightmap_importing = "Relief: Importiere \"{%s}\" (%d → %d m)…",
		heightmap_done = "Relief importiert.",
		biomes_importing = "Biome: „%s“…",
		biomes_done = "Biome importiert.",
		rail_building = "Bahnstrecke: %d Abschnitt(e)…",
		rail_done = "Bahnstrecke: %d / %d Abschnitt(e)%s%s%s.",
		rail_bridges = ", %d Brücken",
		rail_tunnels = ", %d in Tunneln",
		rail_failed = "; %d abgelehnt%s, Lücken in der Nähe von %s",
		rail_critical = "kritischer Fehler",
		towns_done = "%d Stadt(en) erstellt, %d auf ihre tatsächliche Grösse angepasst.",
		industries_building = "Industrien (%d)…",
		industries_done = "Industrien erstellt: %d, benannt: %d%s.",
		industries_missing = ", %d unmöglich",
		roads_building = "Strassen: %d Verbindung(en) zwischen Städten…",
		roads_done = "%d Strassenverbindung(en)%s.",
		roads_partly = " (teilweise abgelehnt)",
		roads_simple = "%d / %d Strassenabschnitt(e) wurde(n) als kleine Landstrassen (2 Fahrbahnen) neu aufgebaut.",
		done = "Die Karte „%s“ wurde erstellt. Speichere sie (im Menü des Karten-Editors).",
		roads_access = "Vom Spiel verbundene Industrien: %d / %d haben eine Strasse%s.",
		roads_access_missing = "; ohne Strasse in der Nähe: %s",
		rail_crossings = "Bahnstrecke: %d Strassenkreuzung(en) im Tunnel unterquert.",
	},
	-- END generated de
	-- BEGIN generated it (tools/i18n/import.mts)
	it = {
		hint_1 = "Per generare una mappa: apri una nuova mappa vuota, delle dimensioni corrette, nell'editor di mappe,",
		hint_2 = "quindi, clicca su \"Genera la mappa\" nell'applicazione RealMap. Tutto viene creato qui, automaticamente.",
		title = "RealMap: “%s”",
		check = "Verifica della mappa in corso…",
		err_not_editor = "Apri l'editor di mappe: la mappa può essere generata solo in una nuova mappa vuota dell'editor di mappe.",
		err_note_missing = "Impossibile trovare il file della mappa (userdata/importcity/%s.lua).",
		err_map_size = "La mappa aperta è composta da %d × %d celle, ne servono %d × %d (%s): crea una nuova mappa di queste dimensioni.",
		err_map_not_empty = "La mappa aperta contiene già cittadine o industrie: crea una nuova mappa vuota.",
		err_heightmap_missing = "La mappa altimetrica \"%s\" non è stata trovata in userdata/heightmaps.",
		err_biomes_missing = "I biomi \"{%s}\" non sono stati trovati in userdata/biomi.",
		err_no_generator = "Nessun generatore di importazione disponibile per il clima di questa mappa.",
		err_towns_missing = "Cittadine non trovate (userdata/towns_industries/%s.lua).",
		err_terrain_refused = "Il gioco ha rifiutato di sostituire il terreno",
		err_towns_refused = "Il gioco ha rifiutato di creare le cittadine",
		warn_economy = "Attenzione: l'economia della mappa è \"%s\", le industrie previste sono per \"%s\".",
		heightmap_importing = "Rilievo: importazione di \"%s\" (%d → %d m)…",
		heightmap_done = "Rilievo importato.",
		biomes_importing = "Biomi: “%s”…",
		biomes_done = "Biomi importati.",
		rail_building = "Ferrovia: %d tratto/i…",
		rail_done = "Ferrovia: %d / %d tratto/i%s%s%s.",
		rail_bridges = ", %d ponti",
		rail_tunnels = ", %d in tunnel",
		rail_failed = "; %d rifiutati%s, lacune vicino a %s",
		rail_critical = "errore critico",
		towns_done = "%d cittadine create, %d impostate alla loro dimensione reale.",
		industries_building = "Industrie (%d)…",
		industries_done = "Industrie create: %d, nominate: %d%s.",
		industries_missing = ", %d impossibili",
		roads_building = "Strade: %d collegamento/i tra le cittadine…",
		roads_done = "%d collegamento(i) stradale(i)%s.",
		roads_partly = " (parzialmente rifiutate)",
		roads_simple = "%d / %d tratto/i di strada ricostruito/i come piccole strade di campagna (2 corsie).",
		done = "Mappa \"%s\" generata. Salvala (nel menu dell'editor di mappe).",
		roads_access = "Industrie collegate dal gioco: %d / %d hanno una strada%s.",
		roads_access_missing = "; senza strada nelle vicinanze: %s",
		rail_crossings = "Ferrovia: %d incrocio/i con strade superato/i sotto in galleria.",
	},
	-- END generated it
	-- BEGIN generated es (tools/i18n/import.mts)
	es = {
		hint_1 = "Para generar un mapa: abre una nueva partida en blanco, de las dimensiones correctas, en el editor de mapas,",
		hint_2 = "Luego, haz clic en \"Generar la mapa\" en la aplicación RealMap. Todo se crea aquí, automáticamente.",
		title = "RealMap: “%s”",
		check = "Verificando el mapa abierto…",
		err_not_editor = "Abre el editor de mapas: el mapa solo se puede generar en una nueva partida vacía del editor de mapas.",
		err_note_missing = "No se encontró la nota del mapa (userdata/importcity/%s.lua).",
		err_map_size = "El mapa abierto tiene %d × %d celdas, se necesitan %d × %d celdas (%s): crea un nuevo mapa de ese tamaño.",
		err_map_not_empty = "El mapa abierto ya contiene localidades o industrias: crea un nuevo mapa vacío.",
		err_heightmap_missing = "Mapa de elevación \"%s\" no encontrado en userdata/heightmaps.",
		err_biomes_missing = "Las \"biomas\" \"%s\" no se encontraron en userdata/biomas.",
		err_no_generator = "No hay ningún generador de importación para el clima de este mapa.",
		err_towns_missing = "Localidades no encontradas (userdata/towns_industries/%s.lua).",
		err_terrain_refused = "El juego se ha negado a reemplazar el terreno",
		err_towns_refused = "El juego se ha negado a crear las localidades",
		warn_economy = "Atención: la economía del mapa es “%s”, y las industrias planificadas son para “%s”.",
		heightmap_importing = "Relieve: importando “%s” (%d → %d m)…",
		heightmap_done = "Relieve importado.",
		biomes_importing = "Biomas: “%s”…",
		biomes_done = "Biomas importados.",
		rail_building = "Ferrocarril: %d tramo(s)…",
		rail_done = "Ferrocarril: %d / %d tramo(s)%s%s%s.",
		rail_bridges = ", %d puentes",
		rail_tunnels = ", %d en túneles",
		rail_failed = "; %d rechazados%s, huecos cerca de %s",
		rail_critical = "error crítico",
		towns_done = "%d localidad(es) creada(s), %d ajustada(s) a su tamaño real.",
		industries_building = "Industrias (%d)…",
		industries_done = "Industrias construidas: %d, con nombre: %d%s.",
		industries_missing = ", %d imposibles",
		roads_building = "Carreteras: %d conexión(es) entre localidades…",
		roads_done = "%d enlace(s) por carretera%s.",
		roads_partly = " (parcialmente rechazado)",
		roads_simple = "%d / %d tramo(s) de carretera reconstruido(s) como pequeñas carreteras rurales (2 carriles).",
		done = "El mapa \"%s\" ha sido generado. Guárdalo (en el menú del editor de mapas).",
		roads_access = "Industrias conectadas por el juego: %d / %d tienen carretera%s.",
		roads_access_missing = "; sin carretera cercana: %s",
		rail_crossings = "Vía férrea: %d cruce(s) con carretera pasado(s) por debajo en túnel.",
	},
	-- END generated es
	-- BEGIN generated zh (tools/i18n/import.mts)
	zh = {
		hint_1 = "要生成地图：请在地图编辑工具中打开一个空白的新地图，确保地图尺寸正确,",
		hint_2 = "然后，请在 RealMap 应用程序中点击“生成地图”按钮。所有内容都将在这里自动构建。",
		title = "RealMap: “%s”",
		check = "正在检查地图…",
		err_not_editor = "打开地图编辑工具：地图只能在地图编辑工具中的全新空白地图中生成。",
		err_note_missing = "找不到地图备注文件 (userdata/importcity/%s.lua)。",
		err_map_size = "当前打开的地图为 %d × %d 个图块，需要 %d × %d（%s）：请新建该尺寸的地图。",
		err_map_not_empty = "当前打开的地图已经包含城镇或产业：请创建一个新的空白地图。",
		err_heightmap_missing = "找不到名为“%s”的“高度图”，位于 userdata/heightmaps 文件夹中。",
		err_biomes_missing = "找不到名为“%s”的生物群系，位于 userdata/biomes 目录中。",
		err_no_generator = "没有针对此地图气候的生成器。",
		err_towns_missing = "找不到城镇 (userdata/towns_industries/%s.lua)。",
		err_terrain_refused = "游戏拒绝替换地形",
		err_towns_refused = "游戏拒绝创建城镇",
		warn_economy = "警告：该地图的经济模式为“%s”，预设的产业类型为“%s”。",
		heightmap_importing = "地形：正在导入“%s”（海拔范围：%d → %d 米）…",
		heightmap_done = "已导入地形。",
		biomes_importing = "生物群系：“%s”…",
		biomes_done = "已导入生物群系。",
		rail_building = "铁路：%d 个路段…",
		rail_done = "铁路：%d / %d 段%s%s%s.",
		rail_bridges = "，%d 段为桥梁",
		rail_tunnels = ", %d 个隧道",
		rail_failed = "; %d 个请求被拒绝%s，附近有缺失区域，位于 %s",
		rail_critical = "关键错误",
		towns_done = "创建了 %d 个城镇，其中 %d 个已调整为实际大小。",
		industries_building = "产业 (%d)…",
		industries_done = "已创建的产业：%d 个，已命名的产业：%d 个%s.",
		industries_missing = ", %d 个无法操作的项目",
		roads_building = "道路：%d 条连接城镇的线路…",
		roads_done = "%d 个公路连接%s.",
		roads_partly = " （部分已拒绝）",
		roads_simple = "%d / %d 个道路段已重建为小型乡村道路（双车道）。",
		done = "地图“%s”已生成。请保存它（在地图编辑工具的菜单中）。",
		roads_access = "游戏已连接的工业：%d / %d 个有道路%s。",
		roads_access_missing = "；附近没有道路：%s",
		rail_crossings = "铁路：%d 处道路交叉以隧道从下方穿过。",
	},
	-- END generated zh
}

local lang = nil

local function detect()
	local ok, info = pcall(function()
		return api.util.getLanguage()
	end)
	local code = nil
	if ok and type(info) == "table" then
		local parts = {}
		for k, v in pairs(info) do
			parts[#parts + 1] = tostring(k) .. "=" .. tostring(v)
		end
		print("[importcity] game language: " .. table.concat(parts, ", "))
		code = info.code or info.locale or info.language or info.name or info.id
	elseif ok and type(info) == "string" then
		code = info
	end
	code = type(code) == "string" and code:sub(1, 2):lower() or "en"
	return STRINGS[code] and code or "en"
end

function M.language()
	if lang == nil then
		lang = detect()
	end
	return lang
end

--- Translated string for key, formatted with string.format(...) when arguments are given.
function M.t(key, ...)
	local s = STRINGS[M.language()][key] or STRINGS.en[key] or key
	if select("#", ...) > 0 then
		local ok, out = pcall(string.format, s, ...)
		return ok and out or s
	end
	return s
end

return M
