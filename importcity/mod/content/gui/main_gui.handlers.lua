-- Handlers of main_gui: this file is ours (TFUI creates it once and never rewrites it).
-- Real town sizes (FACT-016): the Map Editor's towns import only multiplies the capacity the game
-- draws itself, so the towns of an ImportCity map get their target capacity (computed by the app
-- from the population) from here:
--  - automatically: a pump installed by the mod-area button (it ticks even with the window
--    closed) checks the towns every ~2 s in the Map Editor and sizes the ImportCity towns once,
--    right after the « Towns / Industries » import;
--  - or with the window's button « Appliquer les tailles réelles ».
-- The app writes <userdata>/importcity/latest.lua = { name = "<map>" } and
-- <userdata>/importcity/<map>.lua with towns = { { name, x, y, population, capacity } }.
-- react.onStep MUST be registered during a recipe render, on EVERY render (hooks model): the
-- button label expression calls handlers.pump(react), which installs it (as in HQminiMap).

local handlers = {}

local refs = { status = nil }
--- Auto pump: ticks counted, import seen (name|createdAt), towns already sized.
local auto = { tick = 0, key = nil, done = {} }
local PUMP_EVERY = 120
--- Apply automatically only when at least this share of the import's towns is found by name:
--- another map's towns are never resized by position alone.
local AUTO_MIN_NAMED = 0.5

--- How far (game m) a game town may be from an ImportCity town of another name to match it.
local MATCH_RADIUS = 500

local function log(text)
	print("[importcity] " .. text)
end

local function setStatus(text)
	log(text)
	if refs.status ~= nil then
		refs.status:set(text)
	end
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
	local latest = loadUserdata("importcity", "latest")
	if latest == nil or type(latest.name) ~= "string" then
		return nil
	end
	local note = loadUserdata("importcity", latest.name)
	if note == nil or type(note.towns) ~= "table" then
		return nil
	end
	return latest.name, note.towns, note.createdAt
end

--- Game towns: { entity, name, x, y }.
local function gameTowns()
	local out = {}
	local ok, map = pcall(function()
		return api.engine.terrain.makeMapFromGame(false, true, false, false)
	end)
	if not ok or map == nil then
		return out
	end
	for _, t in ipairs(map.towns or {}) do
		out[#out + 1] = { entity = t.existing, name = t.name, x = t.pos.x, y = t.pos.y }
	end
	return out
end

--- The game town for an ImportCity town: same name, else the nearest one within MATCH_RADIUS.
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

--- Split `capacity` over residential / commercial / industrial like the game's own draw.
local function split(capacity, initial)
	local sum = initial[1] + initial[2] + initial[3]
	local shares = sum > 0 and { initial[1] / sum, initial[2] / sum, initial[3] / sum } or { 0.5, 0.3, 0.2 }
	local out = {}
	for i = 1, 3 do
		out[i] = math.max(1, math.floor(capacity * shares[i] + 0.5))
	end
	return out
end

--- Window status text (TFUI: text = handlers.statusText(status)); also keeps the state to update it.
function handlers.statusText(status)
	refs.status = status
	local s = status:old()
	if s ~= nil and s ~= "" then
		return s
	end
	local name = latestImport()
	return name and ("Dernier import ImportCity : " .. name .. ". Importe d'abord ses villes (Towns / Industries), puis applique les tailles.")
		or "Aucun import ImportCity trouvé : génère une carte dans l'app ImportCity."
end

--- Send the capacity commands for one town; true when sent.
local function sizeTown(entity, town, capacity, label)
	local caps = split(capacity, numbers(town.initialLandUseCapacities, 3))
	local factors = numbers(town.sizeFactors, 3)
	if factors[1] <= 0 or factors[2] <= 0 or factors[3] <= 0 then
		factors = { 1, 1, 1 } -- unreadable: a 0 factor would empty the town
	end
	local ok, err = pcall(function()
		api.cmd.sendCommand(api.cmd.makeTownSetInitialLandUseCapacitiesCmd(entity, caps), function(_, success)
			if success then
				-- Rebuild the town's buildings to the new capacity right away.
				api.cmd.sendCommand(api.cmd.makeTownUpdateSizeCmd(entity, factors, true))
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

--- Size the ImportCity towns found in the game. `skip(entity, town, target)` = leave this one.
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
			if not (skip and skip(t.entity, town, target)) and sizeTown(t.entity, town, target.capacity, t.name) then
				done = done + 1
			end
		end
	end
	return name, done, missing, named, #targets
end

function handlers.onApplySizes()
	local name, done, missing = applySizes(nil)
	if name == nil then
		setStatus("Aucun import ImportCity trouvé (userdata/importcity/latest.lua).")
		return
	end
	if done == 0 and #missing > 0 and #gameTowns() == 0 then
		setStatus("Aucune ville dans la partie : importe d'abord les villes de « " .. name .. " ».")
		return
	end
	local text = string.format("« %s » : %d ville(s) mises à la taille réelle.", name, done)
	if #missing > 0 then
		text = text .. " Introuvables : " .. table.concat(missing, ", ") .. "."
	end
	setStatus(text)
end

local function isMapEditor()
	local ok, v = pcall(function()
		return api.gui.game.isMapEditor()
	end)
	return ok and v == true
end

--- One automatic pass: in the Map Editor, size the ImportCity towns not sized yet (each once per import).
local function autoApply()
	if not isMapEditor() then
		return
	end
	local name, targets, createdAt = latestImport()
	if name == nil or #targets == 0 then
		return
	end
	local key = name .. "|" .. tostring(createdAt)
	if auto.key ~= key then
		auto.key = key
		auto.done = {}
	end
	-- Only once enough of this import's towns exist by name (the import has run).
	local towns = gameTowns()
	local byName = {}
	for _, t in ipairs(towns) do
		byName[t.name] = true
	end
	local named = 0
	for _, target in ipairs(targets) do
		if byName[target.name] then
			named = named + 1
		end
	end
	if named < #targets * AUTO_MIN_NAMED then
		return
	end
	local _, done = applySizes(function(entity, town, target)
		if auto.done[entity] then
			return true
		end
		auto.done[entity] = true
		local initial = numbers(town.initialLandUseCapacities, 3)
		local sum = initial[1] + initial[2] + initial[3]
		-- Already at the target (a saved map loaded again): leave it.
		return math.abs(sum - target.capacity) <= target.capacity * 0.02
	end)
	if done and done > 0 then
		setStatus(string.format("« %s » : %d ville(s) mises automatiquement à la taille réelle.", name, done))
	end
end

--- Mod-area button label (TFUI: text = handlers.pump(react)): installs the automatic pump.
function handlers.pump(react)
	if react ~= nil and type(react.onStep) == "function" then
		pcall(function()
			react.onStep(function()
				auto.tick = auto.tick + 1
				if auto.tick % PUMP_EVERY == 0 then
					local ok, err = pcall(autoApply)
					if not ok then
						log("auto apply failed: " .. tostring(err))
					end
				end
			end)
		end)
	end
	return "Import your Town"
end

return handlers
