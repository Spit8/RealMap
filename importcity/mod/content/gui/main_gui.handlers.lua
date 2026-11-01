-- Handlers of main_gui: this file is ours (TFUI creates it once and never rewrites it).
-- RealMap generates the whole map automatically in the Map Editor (DECISION-012): the app writes
-- the map's files and <userdata>/towns_industries/realmap_request.lua; the pump below (installed by the mod-area
-- button, it ticks even with the window closed) sees each new request and hands it to
-- `importcity_auto.lua`, which builds heightmap > biomes > towns > industries > roads > rail and
-- answers in <userdata>/towns_industries/realmap_status.lua. The mod has one window (DECISION-013), opened by the
-- « RealMap » button (`handlers.openWindow`) or when a generation starts; it only shows where it stands.
-- Real town sizes (FACT-016): the towns get their target capacity (computed by the app from the
-- population, note `towns = { { name, x, y, population, capacity } }`) right after they are built.
-- react.onStep MUST be registered during a recipe render, on EVERY render (hooks model): the
-- button icon expression calls handlers.pump(react), which installs it (as in HQminiMap). The
-- mod's window ticks the same pump when the button's one does not (a game update may change how
-- the mod-area button renders). Every step of the pump leaves a line in stdout.txt.

local auto = ug_require "importcity::/gui/importcity_auto.lua"

local handlers = {}

--- Pump: ticks counted; a request is looked for every PUMP_EVERY ticks (~0.5 s), alive.lua
--- rewritten every HEARTBEAT_EVERY ticks (~5 s), a line logged every ALIVE_LOG_EVERY (~5 min).
local pump = { tick = 0, button = 0, lastButton = 0 }
local PUMP_EVERY = 30
local HEARTBEAT_EVERY = 300
local ALIVE_LOG_EVERY = 18000

--- How far (game m) a game town may be from a RealMap town of another name to match it.
local MATCH_RADIUS = 500

local function log(text)
	print("[importcity] " .. text)
end

local function loadUserdata(dir, name)
	local ok, tbl = pcall(function()
		return app.loadUserdata(dir, name)
	end)
	return ok and type(tbl) == "table" and tbl or nil
end

local function comp(entity, ct)
	local ok, c = pcall(function()
		return api.engine.getComponent(entity, api.type.ComponentType[ct])
	end)
	return ok and c or nil
end

--- Copy a game vector (userdata) or table of numbers into a Lua table.
local function numbers(v, n)
	local out = {}
	for i = 1, n do
		local ok, x = pcall(function()
			return v[i]
		end)
		out[i] = ok and type(x) == "number" and x or 0
	end
	return out
end

--- The last map written by the app, or nil.
local function latestImport()
	local latest = loadUserdata(auto.DIR, auto.file("latest"))
	if latest == nil or type(latest.name) ~= "string" then
		return nil
	end
	local note = loadUserdata(auto.DIR, auto.file("note_" .. latest.name))
	if note == nil or type(note.towns) ~= "table" then
		return nil
	end
	return latest.name, note.towns, note.createdAt, note
end

--- Game towns: { entity, name, x, y }, in the order of the game map's towns (and that map).
local function gameTowns()
	local out = {}
	local ok, map = pcall(function()
		return api.engine.terrain.makeMapFromGame(false, true, false, false)
	end)
	if not ok or map == nil then
		return out, nil
	end
	for _, t in ipairs(map.towns or {}) do
		out[#out + 1] = { entity = t.existing, name = t.name, x = t.pos.x, y = t.pos.y }
	end
	return out, map
end

--- The game town for a RealMap town: same name, else the nearest one within MATCH_RADIUS.
local function match(target, towns, used)
	for _, t in ipairs(towns) do
		if not used[t.entity] and t.name == target.name then
			return t
		end
	end
	local best, bestD = nil, MATCH_RADIUS
	for _, t in ipairs(towns) do
		local d = math.sqrt((t.x - target.x) ^ 2 + (t.y - target.y) ^ 2)
		if not used[t.entity] and d < bestD then
			best, bestD = t, d
		end
	end
	return best
end

--- Split `capacity` over residential / commercial / industrial: the real shares sent by the app
--- (`wanted` = { res, com, ind }), else like the game's own draw.
local function split(capacity, initial, wanted)
	local sum = initial[1] + initial[2] + initial[3]
	local shares = sum > 0 and { initial[1] / sum, initial[2] / sum, initial[3] / sum } or { 0.5, 0.3, 0.2 }
	if type(wanted) == "table" and tonumber(wanted.res) and tonumber(wanted.com) and tonumber(wanted.ind) then
		shares = { tonumber(wanted.res), tonumber(wanted.com), tonumber(wanted.ind) }
	end
	local out = {}
	for i = 1, 3 do
		out[i] = math.max(1, math.floor(capacity * shares[i] + 0.5))
	end
	return out
end

--- The « RealMap » button (TFUI onClick): open the mod's window.
function handlers.openWindow()
	auto.open()
end

--- Cargo type ids for the app's goods (« beverages » → ::/cargos/beverages/beverages.cargo); unknown ones skipped.
local function cargoIds(names)
	local out = {}
	for _, n in ipairs(names or {}) do
		local ok, id = pcall(api.res.cargoTypeRep.find, "::/cargos/" .. n .. "/" .. n .. ".cargo")
		if ok and id and id >= 0 then
			out[#out + 1] = id
		end
	end
	return out
end

--- Goods asked by the commercial and industrial land use (residential kept as the game drew it).
local function setNeeds(entity, town, needs, label)
	if type(needs) ~= "table" then
		return
	end
	local com, ind = cargoIds(needs.com), cargoIds(needs.ind)
	if #com == 0 and #ind == 0 then
		return
	end
	local res = {}
	for _, pair in ipairs((town.cargoNeeds or {})[1] or {}) do
		res[#res + 1] = pair[1]
	end
	local ok, err = pcall(function()
		api.cmd.sendCommand(api.cmd.makeTownUpdateCargoNeedsCmd(entity, { res, com, ind }, true), function(_, success)
			if not success then
				log("cargo needs refused for " .. tostring(label))
			end
		end)
	end)
	if ok then
		log(string.format("%s needs: %s / %s", tostring(label), table.concat(needs.com or {}, ","), table.concat(needs.ind or {}, ",")))
	else
		log("cargo needs failed for " .. tostring(label) .. ": " .. tostring(err))
	end
end

--- Send the capacity (and cargo needs) commands for one town; true when sent.
local function sizeTown(entity, town, capacity, label, target)
	local caps = split(capacity, numbers(town.initialLandUseCapacities, 3), target and target.shares)
	local factors = numbers(town.sizeFactors, 3)
	if factors[1] <= 0 or factors[2] <= 0 or factors[3] <= 0 then
		factors = { 1, 1, 1 } -- unreadable: a 0 factor would empty the town
	end
	local ok, err = pcall(function()
		api.cmd.sendCommand(api.cmd.makeTownSetInitialLandUseCapacitiesCmd(entity, caps), function(_, success)
			if success then
				-- Rebuild the town's buildings to the new capacity right away.
				api.cmd.sendCommand(api.cmd.makeTownUpdateSizeCmd(entity, factors, true))
				setNeeds(entity, town, target and target.needs, label)
			else
				log("capacity refused for " .. tostring(label))
			end
		end)
	end)
	if ok then
		log(string.format("%s -> %d (%d/%d/%d)", tostring(label), capacity, caps[1], caps[2], caps[3]))
	else
		log("capacity failed for " .. tostring(label) .. ": " .. tostring(err))
	end
	return ok
end

--- Size the RealMap towns found in the game. `skip(entity, town, target)` = leave this one.
--- Returns name, sized, missing, named (towns matched by name), total.
local function applySizes(skip)
	local name, targets = latestImport()
	if name == nil then
		return nil
	end
	local towns = gameTowns()
	local used, done, missing, named = {}, 0, {}, 0
	for _, target in ipairs(targets) do
		local t = match(target, towns, used)
		local town = t and comp(t.entity, "TOWN")
		if t == nil or town == nil then
			missing[#missing + 1] = target.name
		else
			used[t.entity] = true
			if t.name == target.name then
				named = named + 1
			end
			if not (skip and skip(t.entity, town, target)) and sizeTown(t.entity, town, target.capacity, t.name, target) then
				done = done + 1
			end
		end
	end
	return name, done, missing, named, #targets
end

--- Look for a new request from the app and run it (one at a time).
local function poll()
	if auto.busy() then
		return
	end
	local request = auto.pending()
	if request then
		log("generation of " .. request.name .. " requested by the app")
		auto.start(request, { applySizes = function() return applySizes(nil) end })
	end
end

--- One tick of the pump, from the button (`source` = "button") or the window ("window").
local function step(source)
	pump.tick = pump.tick + 1
	if pump.tick == 1 then
		log("pump ticking (" .. source .. ")")
	end
	if pump.tick % PUMP_EVERY == 0 then
		local ok, err = pcall(poll)
		if not ok then
			auto.logOnce("poll:" .. tostring(err), "poll failed: " .. tostring(err))
		end
	end
	if pump.tick % HEARTBEAT_EVERY == 1 then
		pcall(auto.heartbeat, pump.tick, source)
	end
	if pump.tick % ALIVE_LOG_EVERY == 0 then
		log(string.format("pump alive (%d ticks, %s)", pump.tick, source))
	end
end

--- The window's step (importcity_auto.lua): ticks the pump only if the button did not since.
auto.windowStep = function()
	if pump.button == pump.lastButton then
		step("window")
	end
	pump.lastButton = pump.button
end

--- Mod-area button (TFUI: called by the icon expression): installs the pump, says so once.
function handlers.pump(react)
	if react == nil or type(react.onStep) ~= "function" then
		auto.logOnce("pump:missing", "pump NOT installed: react.onStep unavailable (" .. type(react) .. ")")
		return "RealMap"
	end
	local ok, err = pcall(function()
		react.onStep(function()
			pump.button = pump.button + 1
			step("button")
		end)
	end)
	if ok then
		auto.logOnce("pump:ok", "button pump installed")
	else
		auto.logOnce("pump:err", "pump NOT installed: " .. tostring(err))
	end
	return "RealMap"
end

--- Mod-area button icon (TFUI: ImageView path = handlers.buttonIcon(react), as in HQminiMap; the
--- @2x file is picked on high-DPI screens). The button is always displayed, so it installs the pump:
--- a generation asked by the app runs with the window closed.
function handlers.buttonIcon(react)
	handlers.pump(react)
	return "importcity::/gui/icons/realmap.tga"
end

return handlers
