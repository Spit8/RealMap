-- RealMap automatic generation in the Map Editor (DECISION-012). The app writes the map's files,
-- then <userdata>/towns_industries/realmap_request.lua = { id, name, createdAt }; the pump (main_gui.handlers.lua)
-- hands each new request here. This module checks where we are, then builds, in this order and
-- each step once the previous one has answered:
--   heightmap > biomes > rail > towns (with their real sizes) > industries (with their names) > roads
-- (the railway right after the terrain, DECISION-014: towns, industries and the game's roads adapt
-- to the track, which the app designed around the towns' places)
-- and reports every stage in <userdata>/towns_industries/realmap_status.lua, which the app reads back.
-- Heightmap and biomes go through the game's own map computation, exactly like the Map Editor's
-- import tabs (FACT-025): a `builtin.MapPreviewComp` (hosted in the mod's window) turns the import
-- settings into a map, then `makeWorldReplaceTerrainCmd` applies it. That window is the mod's only
-- one (DECISION-013): opened by the « RealMap » button or when a generation starts, it shows the
-- instructions, then the stages and the last report.

local react = ug_require "::/gui/main/react.lua"
local builtin = ug_require "::/gui/main/builtin.lua"
local game_react_globals = ug_require "::/gui/main/game_react_globals.tl"
local build = ug_require "importcity::/gui/importcity_build.lua"
local i18n = ug_require "importcity::/gui/importcity_i18n.lua"
local VERSION = ug_require "importcity::/gui/importcity_version.lua"
local tr = i18n.t
local okParamUtil, scriptparamutil = pcall(ug_require, "/gui/main/script_param_util.tl")

local A = {}

local WINDOW_ID = "importcity.auto"
--- Since game build 40420/40423, app.loadUserdata / app.saveUserdata only accept `towns_industries`,
--- `heightmaps` and `mod_presets` (FACT-034): the files shared with the app live in
--- towns_industries, named realmap_<name> (request, status, alive, latest, note_<map>).
A.DIR = "towns_industries"
function A.file(name)
	return "realmap_" .. name
end

--- The running generation: { id, name, note, stage, report = {lines}, log, preview, version }.
local run = nil
--- What the progress window shows; `version` changes on every update.
local view = { version = 0, title = "RealMap", lines = {}, preview = nil }
--- Shown before any generation.
local HINT = { tr("hint_1"), tr("hint_2") }
--- Lines kept in the window.
local MAX_LINES = 12

local function log(text)
	print("[importcity] " .. text)
end
A.log = log

--- Log `text` the first time `key` is seen (failures that would repeat every step).
local logged = {}
local function logOnce(key, text)
	if not logged[key] then
		logged[key] = true
		log(text)
	end
end
A.logOnce = logOnce

--- Read <userdata>/<dir>/<name>.lua; an error (folder refused by the game, say) is logged once.
local function loadUserdata(dir, name)
	local ok, tbl = pcall(function()
		return app.loadUserdata(dir, name)
	end)
	if not ok then
		logOnce("load:" .. dir .. "/" .. name, dir .. "/" .. name .. ".lua not read: " .. tostring(tbl))
	end
	return ok and type(tbl) == "table" and tbl or nil
end

--- Write <userdata>/<dir>/<name>.lua; a failure is logged once per file (the app then hears nothing).
local function saveUserdata(dir, name, tbl)
	local ok, err = pcall(function()
		app.saveUserdata(dir, name, tbl)
	end)
	if not ok then
		logOnce("save:" .. name, name .. ".lua not saved: " .. tostring(err))
	end
	return ok
end

--- The userdata folder the game uses (the app must write there), "?" when the game does not say.
local USERDATA = (function()
	local ok, dir = pcall(function()
		return app.getUserDataFolder()
	end)
	return ok and type(dir) == "string" and dir or "?"
end)()
log("mod " .. tostring(VERSION) .. " loaded, userdata " .. USERDATA)

local function touch()
	view.version = view.version + 1
end

--- The answer the app reads: stage, message, report so far.
local function status(stage, message, failed)
	saveUserdata(A.DIR, A.file("status"), {
		id = run.id, stage = stage, message = message, failed = failed, report = run.report,
	})
	log(stage .. ": " .. tostring(message))
	view.lines[#view.lines + 1] = message
	touch()
end

--- An entry of `list` (heightmaps or biomes the game lists) for file `base`, with or without extension.
local function entry(list, base)
	for _, e in ipairs(list or {}) do
		if e == base or e:sub(1, #base + 1) == base .. "." then
			return e
		end
	end
	return nil
end

--- Size of the open map in tiles (256 m). `makeMapFromGame` without the heightmap reports 0 × 0
--- tiles (seen in game), so: the terrain's bounding box, else the full map with its heightmap.
local function mapTiles()
	local ok, bbox = pcall(function()
		return api.engine.terrain.getBoundingBox()
	end)
	if ok and bbox and bbox.min and bbox.max then
		local w, h = bbox.max.x - bbox.min.x, bbox.max.y - bbox.min.y
		if w > 0 and h > 0 then
			return math.floor(w / 256 + 0.5), math.floor(h / 256 + 0.5)
		end
	end
	local okMap, map = pcall(function()
		return api.engine.terrain.makeMapFromGame(true, false, false, false)
	end)
	if okMap and map then
		return map.numTilesX or 0, map.numTilesY or 0
	end
	return 0, 0
end

local function isMapEditor()
	local ok, v = pcall(function()
		return api.gui.game.isMapEditor()
	end)
	return ok and v == true
end

--- The mod's window: instructions, stages, last report. During the heightmap and biomes stages it
--- hosts the map computation, one step after it appears, like the Map Editor's own preview.
--- Registered on first use (button click or the pump's step: this module is first loaded during a
--- render). Fixed width from the stylesheet (class `realmap-window`) so every line fits.
local function renderWindow(_params)
	local version = react.useState(-1)
	local ready = react.useState(false)
	react.onStep(function()
		-- Second pump (main_gui.handlers.lua): runs it when the button's one does not tick.
		if A.windowStep then
			A.windowStep()
		end
		if version:old() ~= view.version then
			version:set(view.version)
		end
		if not ready:old() then
			ready:set(true)
		end
	end)
	local children = {}
	local lines = #view.lines > 0 and view.lines or HINT
	for i = math.max(1, #lines - MAX_LINES + 1), #lines do
		children[#children + 1] = builtin.TextView { text = lines[i], meta = { class = "font-scale-body" } }
	end
	local p = view.preview
	if p and ready:old() then
		children[#children + 1] = builtin.MapPreviewComp {
			mapColoring = api.res.climateRep.get(api.res.climateRep.find(api.res.getBaseConfig().climate)).mapColoring,
			showMapSize = true,
			showTownAndIndustryCount = false,
			showBiomesColors = p.biomes,
			mode = p.mode,
			inputMap = p.inputMap,
			economy = api.res.getBaseConfig().economyId,
			params = p.params,
			seed = "",
			locationsConfig = api.res.getBaseConfig().locations,
			onReady = function(map)
				-- Once per stage: the component may answer again after a re-render.
				if view.preview == p then
					view.preview = nil
					touch()
					p.onReady(map)
				end
			end,
		}
	end
	return builtin.Window {
		id = WINDOW_ID,
		title = view.title,
		initialX = 0.3,
		initialY = 0.1,
		closable = true,
		movable = true,
		expanded = true,
		onClose = function()
			pcall(function()
				api.gui.byId.setVisible(WINDOW_ID, false)
			end)
		end,
		meta = { class = "realmap-window" },
		content = builtin.BoxLayout { orientation = builtin.type.Orientation.Vertical, meta = { class = "my-root" }, children = children },
	}
end

local function windowRecipe()
	if A.Window == nil then
		A.Window = react.RegisterWrapperRecipe("RealmapWindow", builtin.Window, renderWindow)
	end
	return A.Window
end

local function openWindow()
	local ok, err = pcall(function()
		local recipe = windowRecipe()
		local wapi = game_react_globals.getDefaultWindowApi()
		if wapi ~= nil then
			wapi.addSingletonWindow(recipe, {})
			pcall(function()
				api.gui.byId.setVisible(WINDOW_ID, true)
			end)
			wapi.moveSingletonWindowToFront(recipe)
		end
	end)
	if not ok then
		log("window failed: " .. tostring(err))
	end
end

--- Open the window (the « RealMap » button).
A.open = openWindow

--- Compute a map from import settings in the window, then apply it with the editor's command.
local function replaceTerrain(mode, params, biomes, keepAssets, nextStep, fail)
	local inputMap = api.engine.terrain.makeMapFromGame(true, false, false, keepAssets)
	inputMap.waterLevel = run.note.waterLevel or 0
	view.preview = {
		mode = mode, inputMap = inputMap, params = params or {}, biomes = biomes,
		onReady = function(map)
			local ok, err = pcall(function()
				pcall(function()
					api.gui.map.reloadMaterialIndexManagerPipeline()
				end)
				api.cmd.sendCommand(
					api.cmd.makeWorldReplaceTerrainCmd(map, api.res.getBaseConfig().terrain, "", api.engine.util.getWorld(), keepAssets),
					function(_, success)
						if success then
							local okNext, errNext = pcall(nextStep)
							if not okNext then
								fail(tostring(errNext))
							end
						else
							fail(tr("err_terrain_refused"))
						end
					end)
			end)
			if not ok then
				fail(tostring(err))
			end
		end,
	}
	touch()
end

--- The import generator of the map's climate (« Temperate (Import) »…) and its default parameters.
local function importGenerator()
	local climate = api.res.getBaseConfig().climate
	local best, bestOrder = nil, math.huge
	for k, _ in pairs(app.res.terrainGeneratorRep.getAll()) do
		local gen = app.res.terrainGeneratorRep.get(k)
		if gen.climate == climate and gen.isImportGenerator and (gen.order or 0) < bestOrder then
			best, bestOrder = k, gen.order or 0
		end
	end
	if best == nil then
		return nil
	end
	-- Default values, as the Map Editor fills them (`addMissingGeneratorParams`).
	local params = {}
	for _, sp in ipairs(app.res.terrainGeneratorRep.get(best).params or {}) do
		local ok, v = pcall(function()
			return scriptparamutil.getScriptParamDefaultValueIndex(sp.numbers, sp.defaultIndex)
		end)
		params[sp.key] = (okParamUtil and ok and v) or sp.defaultIndex or 0
	end
	return app.res.terrainGeneratorRep.getName(best), params
end

--- Game towns { entity, name, x, y } in the order of the game map, and that map.
local function gameTowns()
	local map = api.engine.terrain.makeMapFromGame(false, true, false, false)
	local out = {}
	for _, t in ipairs(map.towns or {}) do
		out[#out + 1] = { entity = t.existing, name = t.name, x = t.pos.x, y = t.pos.y }
	end
	return out, map
end

--- `opts.applySizes()` sizes the towns of the latest import (main_gui.handlers.lua).
local function startRun(request, opts)
	local note = loadUserdata(A.DIR, A.file("note_" .. request.name))
	run = { id = request.id, name = request.name, note = note, report = {} }
	view.title = tr("title", tostring(request.name))
	view.lines = {}
	view.preview = nil
	openWindow()
	local stage = "check"
	local function fail(message)
		if run == nil or run.id ~= request.id then
			return
		end
		view.preview = nil
		status("error", message, stage)
		run = nil
	end
	local function say(line)
		run.report[#run.report + 1] = line
	end
	status("check", tr("check"))
	if not isMapEditor() then
		return fail(tr("err_not_editor"))
	end
	if note == nil or type(note.tiles) ~= "table" then
		return fail(tr("err_note_missing", tostring(request.name)))
	end
	local map = api.engine.terrain.makeMapFromGame(false, true, true, false)
	local tx, ty = note.tiles[1], note.tiles[2]
	local mx, my = mapTiles()
	if mx ~= tx or my ~= ty then
		return fail(tr("err_map_size", mx, my, tx, ty, tostring(note.mapSize)))
	end
	if #(map.towns or {}) > 0 or #(map.industries or {}) > 0 then
		return fail(tr("err_map_not_empty"))
	end
	local heightmap = entry(app.getAllHeightmaps(), note.heightmap or request.name)
	if heightmap == nil then
		return fail(tr("err_heightmap_missing", tostring(note.heightmap)))
	end
	local biomeFiles = app.getAllBiomes()
	local names = note.biomes or {}
	local biomeMap = entry(biomeFiles, names.biomes or (request.name .. "_biomes"))
	if biomeMap == nil then
		return fail(tr("err_biomes_missing", tostring(names.biomes)))
	end
	local generator, genParams = importGenerator()
	if generator == nil then
		return fail(tr("err_no_generator"))
	end
	local townsData = loadUserdata("towns_industries", request.name)
	if townsData == nil then
		return fail(tr("err_towns_missing", tostring(request.name)))
	end
	local economy = api.res.getBaseConfig().economyId
	if note.economy and economy and not tostring(economy):find(note.economy, 1, true) then
		say(tr("warn_economy", tostring(economy), tostring(note.economy)))
	end

	local ctx = build.context(note, log)
	local steps = {
		function(nextStep)
			stage = "heightmap"
			status("heightmap", tr("heightmap_importing", heightmap, note.minHeight, note.maxHeight))
			local mode = api.type.ImportExportHeightmapMode.new()
			mode.import = true
			mode.minH = note.minHeight
			mode.maxH = note.maxHeight
			mode.generateAssets = true
			mode.fileName = heightmap
			replaceTerrain(mode, nil, false, false, function()
				say(tr("heightmap_done"))
				nextStep()
			end, fail)
		end,
		function(nextStep)
			stage = "biomes"
			status("biomes", tr("biomes_importing", biomeMap))
			local mode = api.type.ImportBiomesMode.new()
			mode.terrainGenerator = generator
			mode.biomeMap = biomeMap
			local layers = {}
			local climate = api.res.climateRep.get(api.res.climateRep.find(api.res.getBaseConfig().climate))
			for _, layer in ipairs((climate.dataMaps and climate.dataMaps.layers) or {}) do
				local file = entry(biomeFiles, names[layer.key] or (request.name .. "_" .. layer.key))
				if file then
					layers[layer.key] = file
				end
			end
			mode.layerMaps = layers
			replaceTerrain(mode, genParams, true, false, function()
				say(tr("biomes_done"))
				nextStep()
			end, fail)
		end,
	}
	for _, pts in ipairs((note.rail and note.rail.lines) or {}) do
		steps[#steps + 1] = function(nextStep)
			stage = "rail"
			status("rail", tr("rail_building", ctx.report.railSegments))
			build.line(ctx, pts, nextStep)
		end
	end
	if ctx.report.railSegments > 0 then
		steps[#steps + 1] = function(nextStep)
			local r = ctx.report
			say(tr("rail_done", r.railBuilt, r.railSegments,
				r.railBridgeEdges > 0 and tr("rail_bridges", r.railBridgeEdges) or "",
				r.railTunnelEdges > 0 and tr("rail_tunnels", r.railTunnelEdges) or "",
				r.railFailed > 0 and tr("rail_failed", r.railFailed,
					r.railReason and (" (" .. r.railReason .. ")") or "", table.concat(r.railGaps, " ; ")) or ""))
			nextStep()
		end
	end
	local after = {
		function(nextStep)
			stage = "towns"
			status("towns", "Villes…")
			local towns = {}
			for _, t in ipairs(townsData.towns or {}) do
				local mt = api.type.Map.Town.new()
				mt.pos = api.type.Vec2f.new(t.position.x, t.position.y)
				if api.engine.terrain.isValidCoordinate(mt.pos) then
					mt.name = t.name
					mt.sizeFactors = t.sizeFactors or { 1, 1, 1 }
					towns[#towns + 1] = mt
				end
			end
			local result = api.engine.mapgen.createTowns("", towns)
			api.cmd.sendCommand(api.cmd.makeTownCreateCmd(result.toAdd), function(_, success)
				if not success then
					return fail(tr("err_towns_refused"))
				end
				local ok, err = pcall(function()
					local _, sized = opts.applySizes()
					say(tr("towns_done", #(result.toAdd or {}), sized or 0))
					nextStep()
				end)
				if not ok then
					fail(tostring(err))
				end
			end)
		end,
		function(nextStep)
			stage = "industries"
			local list = note.industries or {}
			status("industries", tr("industries_building", #list))
			local towns, gmap = gameTowns()
			local byName = {}
			for i, t in ipairs(towns) do
				byName[t.name] = i
			end
			build.setTowns(ctx, note, gmap, towns, byName)
			build.industries(ctx, list, function()
				local r = ctx.report
				say(tr("industries_done", r.industries, r.renamed,
					r.industriesMissing > 0 and tr("industries_missing", r.industriesMissing) or ""))
				nextStep()
			end)
		end,
		function(nextStep)
			stage = "roads"
			status("roads", tr("roads_building", ctx.report.connections))
			build.connect(ctx, function()
				say(tr("roads_done", ctx.report.connections, ctx.report.roadsOk and "" or tr("roads_partly")))
				nextStep()
			end)
		end,
	}
	for _, fn in ipairs(after) do
		steps[#steps + 1] = fn
	end
	build.chain(steps, log, function()
		status("done", tr("done", run.name))
		run = nil
	end, function(err)
		fail(tostring(err))
	end)
end

--- Run a request; an error the checks did not foresee (a game API changed by an update, say) still
--- ends in status.lua, so the app shows it instead of waiting.
function A.start(request, opts)
	local ok, err = pcall(startRun, request, opts)
	if not ok then
		log("generation failed: " .. tostring(err))
		if run ~= nil and run.id == request.id then
			view.preview = nil
			status("error", tostring(err), "check")
			run = nil
		end
	end
end

--- A generation is running (its commands answer later).
function A.busy()
	return run ~= nil
end

--- What the mod made of request.lua, for alive.lua and the log. No clock involved (game updates
--- may change the game's clock functions): the request found at the first look is the baseline, left alone (an old
--- one, or sent while the editor was loading: the app then sends it again under a new id).
local seen = { started = false, baseline = nil, id = nil, decision = nil }
--- Last pump tick count and source, written in alive.lua.
local beat = { ticks = 0, source = "?" }

--- alive.lua: the mod's sign of life, rewritten by the pump every few seconds and on each new
--- decision. The app judges how recent it is by the file's date, and reads where the mod stands.
local function writeAlive()
	return saveUserdata(A.DIR, A.file("alive"), {
		version = VERSION, userdata = USERDATA, editor = isMapEditor(), ticks = beat.ticks, pump = beat.source,
		busy = run ~= nil, seen = seen.id, decision = seen.decision,
	})
end

function A.heartbeat(ticks, source)
	beat.ticks, beat.source = ticks, source
	return writeAlive()
end

local function decide(request, decision)
	local id = request and request.id
	if seen.id ~= id or seen.decision ~= decision then
		seen.id, seen.decision = id, decision
		log(string.format("request %s %s: %s", tostring(id), tostring(request and request.name), decision))
		writeAlive()
	end
	return decision
end

--- The request to run, if any: readable, not cancelled by the app, sent after the mod started
--- looking, not answered yet. A missing file makes the game log an error on every read, even
--- under pcall: the first look leaves an empty request in its place (the app overwrites it).
function A.pending()
	local request = loadUserdata(A.DIR, A.file("request"))
	local first = not seen.started
	seen.started = true
	if request == nil or (request.id == nil and request.name == nil) then
		if first then
			saveUserdata(A.DIR, A.file("request"), {})
		end
		return nil
	end
	if type(request.id) ~= "number" or type(request.name) ~= "string" then
		decide(request, "unreadable")
		return nil
	end
	if first then
		seen.baseline = request.id
	end
	if request.cancelled == true then
		decide(request, "cancelled")
		return nil
	end
	-- Before reading the status (missing until the first answer): no read for an old request.
	if request.id == seen.baseline then
		decide(request, "baseline")
		return nil
	end
	local st = loadUserdata(A.DIR, A.file("status"))
	if st and st.id == request.id then
		decide(request, "answered")
		return nil
	end
	decide(request, "accepted")
	return request
end

return A
