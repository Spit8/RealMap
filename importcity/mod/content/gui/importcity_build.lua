-- RealMap building blocks for the automatic generation (`importcity_auto.lua`, DECISION-012),
-- from the note <userdata>/importcity/<map>.lua written by the app:
--  - industries, built like the Map Editor does (`createIndustries` + `createIndustryProposal`) and
--    named (`industries[i].name`, FACT-024);
--  - roads between the town pairs the app chose (`connections`), by the game's own command (its
--    routing, its road type for the year; it also links every industry that exists);
--  - the main railway (`rail.lines`): track segments along the points, a few at a time; a refused
--    piece is tried segment by segment, then skipped and counted, with the game's reason.
-- Each block calls `nextStep()` once its commands have answered (callbacks).

local i18n = ug_require "importcity::/gui/importcity_i18n.lua"

local B = {}

local TRACK_SIMPLE = "::/infrastructure/track/simple/simple.street_template"
local TRACK_STANDARD = "::/infrastructure/track/standard/standard.street_template"
local STANDARD_FROM = 1930
--- Track segments sent in one proposal.
local RAIL_CHUNK = 8
--- A built industry is matched to the note's by type and position within this (game m).
local MATCH_M = 300

local function vec2(x, y)
	return api.type.Vec2f.new(x, y)
end

local function vec3(x, y, z)
	return api.type.Vec3f.new(x, y, z)
end

local function comp(entity, ct)
	local ok, c = pcall(function()
		return api.engine.getComponent(entity, api.type.ComponentType[ct])
	end)
	return ok and c or nil
end

--- A new engine record by type name, or nil when the API has no such constructor.
local function new(name)
	local ok, v = pcall(function()
		return api.type[name].new()
	end)
	return ok and v or nil
end

local function height(x, y)
	local ok, z = pcall(function()
		return api.engine.terrain.getHeightAt(vec2(x, y))
	end)
	return ok and type(z) == "number" and z or 0
end

local function year()
	local ok, y = pcall(function()
		return api.engine.util.getYear()
	end)
	return ok and type(y) == "number" and y or 1900
end

--- Run `steps` one after the other: each is function(nextStep) and calls nextStep() when done.
--- A step that throws is logged and skipped unless `stop(err, i)` is given (then the chain ends).
function B.chain(steps, log, done, stop)
	local i = 0
	local function nextStep()
		i = i + 1
		if i > #steps then
			if done then
				done()
			end
			return
		end
		local called = false
		local ok, err = pcall(steps[i], function()
			if not called then
				called = true
				nextStep()
			end
		end)
		if not ok then
			log("step " .. i .. " failed: " .. tostring(err))
			if stop then
				called = true
				stop(err, i)
			elseif not called then
				called = true
				nextStep()
			end
		end
	end
	nextStep()
end

--- Town pairs as indices into `entities`, with the index base the engine uses (FACT-024: the editor
--- passes `getDefaultTownConnections` results straight through; 0-based unless it shows otherwise).
function B.indexBase(map)
	local ok, conns = pcall(function()
		return api.engine.mapgen.getDefaultTownConnections(map.towns)
	end)
	local n = #(map.towns or {})
	if ok and conns then
		for _, c in ipairs(conns) do
			if c[1] == 0 or c[2] == 0 then
				return 0
			end
			if c[1] == n or c[2] == n then
				return 1
			end
		end
	end
	return 0
end

--- The note's industry for a built one: same file, nearest position within MATCH_M, not taken yet.
local function claim(list, taken, fileName, x, y)
	local best, bestD = nil, MATCH_M
	for i, m in ipairs(list) do
		if not taken[i] and m.fileName == fileName then
			local d = math.sqrt((m.x - x) ^ 2 + (m.y - y) ^ 2)
			if d < bestD then
				best, bestD = i, d
			end
		end
	end
	if best then
		taken[best] = true
	end
	return best
end

--- Translation of an engine Mat4f (column-major, 1-based): x, y, or nil.
local function position(transf)
	local ok, x, y = pcall(function()
		return transf[13], transf[14]
	end)
	if ok and type(x) == "number" and type(y) == "number" then
		return x, y
	end
	return nil
end

--- Name the construction among `entities` (command result {{entity, revision}}); true when sent.
local function rename(entities, name, log)
	for _, r in ipairs(entities or {}) do
		local e = r[1]
		if e and comp(e, "CONSTRUCTION") then
			local ok = pcall(function()
				api.cmd.sendCommand(api.cmd.makeEntitySetNameCmd(e, name))
			end)
			if not ok then
				log("rename failed: " .. tostring(name))
			end
			return ok
		end
	end
	return false
end

--- Build `list` (note industries) like the Map Editor, name them; calls nextStep when all answered.
function B.industries(ctx, list, nextStep)
	if #list == 0 then
		return nextStep()
	end
	local wanted = {}
	for i, m in ipairs(list) do
		local mi = api.type.Map.Industry.new()
		mi.pos = vec2(m.x, m.y)
		mi.angle = m.angle or 0
		mi.onWater = m.onWater == true
		mi.fileName = m.fileName
		mi.tag = m.tag
		wanted[i] = mi
	end
	local result = api.engine.mapgen.createIndustries("", wanted)
	local context = api.type.Context.new()
	local jobs, taken = {}, {}
	for k, info in ipairs(result.toAdd or {}) do
		local x, y = position(info.transf)
		local i
		if x then
			i = claim(list, taken, info.fileName, x, y)
		elseif not taken[k] then
			-- Without a readable position, the results come in the order asked.
			i = k
			taken[k] = true
		end
		local proposal = api.engine.util.proposal.createIndustryProposal("", info, context)
		if proposal then
			jobs[#jobs + 1] = { proposal = proposal, item = i and list[i] or nil }
		end
	end
	ctx.report.industriesMissing = ctx.report.industriesMissing + (#list - #jobs)
	if #jobs == 0 then
		return nextStep()
	end
	-- Count every job before sending: a callback may answer at once.
	local pending = #jobs
	for _, job in ipairs(jobs) do
		api.cmd.sendCommand(api.cmd.makeWorldBuildProposalCmd(job.proposal, context, true, false), function(_, success, entities)
			if success then
				ctx.report.industries = ctx.report.industries + 1
				if job.item and job.item.name and rename(entities, job.item.name, ctx.log) then
					ctx.report.renamed = ctx.report.renamed + 1
				end
			else
				ctx.report.industriesMissing = ctx.report.industriesMissing + 1
				ctx.log("industry refused: " .. tostring(job.item and job.item.name))
			end
			pending = pending - 1
			if pending == 0 then
				nextStep()
			end
		end)
	end
end

--- The game's town connection command (its routing; it also links every existing industry).
function B.connect(ctx, nextStep)
	if #ctx.conns == 0 then
		return nextStep()
	end
	api.cmd.sendCommand(api.cmd.makeTownConnectWithIndustriesCmd(ctx.townEntities, ctx.conns, false), function(_, success)
		ctx.report.roadsOk = ctx.report.roadsOk and success
		if not success then
			ctx.log("town connections refused")
		end
		nextStep()
	end)
end

--- The end node of the last segment the game added (as `track_builder.tl` reads it), or nil.
local function addedEnd(res)
	local ok, node = pcall(function()
		local segs = res.proposal.proposal.addedSegments
		return segs[#segs].comp.node1
	end)
	return ok and type(node) == "number" and node >= 0 and node or nil
end

local function onWater(x, y)
	local ok, w = pcall(function()
		return api.engine.terrain.isOnWater(vec2(x, y))
	end)
	return ok and w == true
end

--- Index of the bridge used over water (stone bridge), or nil when the game has none.
local bridgeIndex = nil
local function bridge()
	if bridgeIndex == nil then
		bridgeIndex = false
		for _, name in ipairs({ "::/infrastructure/bridge/stone.bridge", "stone.bridge" }) do
			local ok, i = pcall(function()
				return api.res.bridgeTypeRep.find(name)
			end)
			if ok and type(i) == "number" and i >= 0 then
				bridgeIndex = i
				break
			end
		end
	end
	return bridgeIndex or nil
end

local function enum(kind, name)
	local ok, v = pcall(function()
		return api.type["enum"][kind][name]
	end)
	return ok and v or nil
end

--- Why the game would refuse `proposal` (its error state as text), or nil.
local function refusal(proposal)
	local ok, text = pcall(function()
		local es = api.engine.util.proposal.makeProposalData(proposal, nil).errorState
		if es == nil then
			return nil
		end
		local parts = {}
		for _, key in ipairs({ "messages", "warnings" }) do
			local okList, list = pcall(function()
				return es[key]
			end)
			if okList and type(list) == "table" then
				for _, m in ipairs(list) do
					parts[#parts + 1] = tostring(m)
				end
			end
		end
		local okCrit, critical = pcall(function()
			return es.critical
		end)
		if #parts == 0 and okCrit and critical then
			parts[1] = i18n.t("rail_critical")
		end
		return #parts > 0 and table.concat(parts, ", ") or nil
	end)
	return ok and text or nil
end

--- Index of the tunnel used by the railway (`tunnel_a`, or `tunnel_b` from 1970), or nil.
local tunnelIndex = nil
local function tunnel()
	if tunnelIndex == nil then
		tunnelIndex = false
		local names = year() >= 1970 and { "::/infrastructure/tunnel/tunnel_b.tunnel", "::/infrastructure/tunnel/tunnel_a.tunnel" }
			or { "::/infrastructure/tunnel/tunnel_a.tunnel" }
		for _, name in ipairs(names) do
			local ok, i = pcall(function()
				return api.res.tunnelTypeRep.find(name)
			end)
			if ok and type(i) == "number" and i >= 0 then
				tunnelIndex = i
				break
			end
		end
	end
	return tunnelIndex or nil
end

--- One designed railway line (DECISION-014): nodes `pts` = { x, y, z, tx, ty, tz, kind } from the
--- app (height of the profile, unit tangent, kind of the edge leaving the node: "n" track, "b"
--- bridge, "t" tunnel), RAIL_CHUNK edges per proposal, chained on the node the game created. Each
--- edge is filled like the game's own track builder (`mission/tasks/auto_builder/track_builder.tl`,
--- FACT-027), with tangents = unit tangent × edge length (a smooth Hermite curve through the nodes).
--- A refused proposal is tried edge by edge; a refused track edge is tried once as a bridge; what
--- is still refused is skipped and its position reported.
function B.line(ctx, pts, nextStep)
	if #pts < 2 then
		return nextStep()
	end
	local name = year() >= STANDARD_FROM and TRACK_STANDARD or TRACK_SIMPLE
	local template = api.res.streetTemplateRep.get(api.res.streetTemplateRep.find(name))
	local k, retryUntil, prevNode, asBridge = 1, 0, nil, false
	local function pos(i)
		local p = pts[i]
		return vec3(p.x, p.y, p.z or height(p.x, p.y))
	end
	local function tangent(i, length)
		local p = pts[i]
		if p.tx == nil then
			local a, b = pts[math.max(1, i - 1)], pts[math.min(#pts, i + 1)]
			local d = math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2)
			return vec3((b.x - a.x) / d * length, (b.y - a.y) / d * length, 0)
		end
		return vec3(p.tx * length, p.ty * length, p.tz * length)
	end
	local function step()
		if k >= #pts then
			return nextStep()
		end
		-- After a refused piece: edge by edge until its end.
		local n = k < retryUntil and 1 or RAIL_CHUNK
		local last = math.min(#pts, k + n)
		local proposal = api.type.SimpleProposal.new()
		local nodes, edges, ids, at = {}, {}, {}, {}
		local id = -1
		for i = k, last do
			if i == k and prevNode then
				ids[i] = prevNode
				local c = comp(prevNode, "BASE_NODE")
				at[i] = c and c.position or pos(i)
			else
				local node = api.type.NodeAndEntity.new()
				node.entity = id
				local base = node.comp or new("BaseNode")
				at[i] = pos(i)
				base.position = at[i]
				node.comp = base
				nodes[#nodes + 1] = node
				ids[i] = id
				id = id - 1
			end
		end
		for i = k, last - 1 do
			local a, b = at[i], at[i + 1]
			local length = math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2 + (b.z - a.z) ^ 2)
			local kind = asBridge and "b" or pts[i].kind or "n"
			local edge = api.type.SegmentAndEntity.new()
			edge.entity = id
			id = id - 1
			edge.type = 1 -- track
			local base = edge.comp or new("BaseEdge")
			base.node0 = ids[i]
			base.node1 = ids[i + 1]
			base.tangent0 = tangent(i, length)
			base.tangent1 = tangent(i + 1, length)
			base.position0 = a
			base.position1 = b
			if kind == "b" and bridge() then
				base.type = enum("BaseEdgeType", "BRIDGE")
				base.typeIndex = bridge()
			elseif kind == "t" and tunnel() then
				base.type = enum("BaseEdgeType", "TUNNEL")
				base.typeIndex = tunnel()
			else
				base.type = enum("BaseEdgeType", "NORMAL")
				base.typeIndex = 1
			end
			base.laneConfigs = template.laneConfigs
			base.roadTemplate = name
			base.roadStyle = template.streetStyle
			base.roadType = enum("RoadType", "TRACK")
			edge.comp = base
			edges[#edges + 1] = edge
		end
		proposal.streetProposal.nodesToAdd = nodes
		proposal.streetProposal.edgesToAdd = edges
		local reason = refusal(proposal)
		api.cmd.sendCommand(api.cmd.makeWorldBuildProposalCmd(proposal, nil, false, false), function(res, success)
			local count = last - k
			if success then
				ctx.report.railBuilt = ctx.report.railBuilt + count
				for i = k, last - 1 do
					local kind = asBridge and "b" or pts[i].kind
					if kind == "b" then
						ctx.report.railBridgeEdges = ctx.report.railBridgeEdges + 1
					elseif kind == "t" then
						ctx.report.railTunnelEdges = ctx.report.railTunnelEdges + 1
					end
				end
				prevNode = addedEnd(res)
				k = last
				asBridge = false
			elseif n > 1 then
				-- Same start again, one edge at a time.
				retryUntil = last
			elseif not asBridge and (pts[k].kind or "n") == "n" and bridge() then
				asBridge = true
			else
				ctx.report.railFailed = ctx.report.railFailed + 1
				if reason and ctx.report.railReason == nil then
					ctx.report.railReason = reason
				end
				local where = string.format("%d, %d", math.floor(pts[k].x), math.floor(pts[k].y))
				if #ctx.report.railGaps < 5 then
					ctx.report.railGaps[#ctx.report.railGaps + 1] = where
				end
				ctx.log("track refused at " .. where .. ": " .. tostring(reason))
				prevNode = nil
				k = last
				asBridge = false
			end
			step()
		end)
	end
	step()
end

--- Shared state of one generation: report, then (once the towns exist, `B.setTowns`) the towns in
--- the game's order and the town pairs.
function B.context(note, log)
	local ctx = {
		log = log,
		townEntities = {},
		conns = {},
		report = {
			roadsOk = true, connections = 0, industries = 0, industriesMissing = 0, renamed = 0,
			railBuilt = 0, railSegments = 0, railFailed = 0, railReason = nil, railGaps = {},
			railBridgeEdges = 0, railTunnelEdges = 0,
		},
	}
	for _, pts in ipairs((note.rail and note.rail.lines) or {}) do
		ctx.report.railSegments = ctx.report.railSegments + math.max(0, #pts - 1)
	end
	return ctx
end

--- `towns` = game towns {entity, name, x, y} in the order of `map.towns`; `byName[note town name]` =
--- index into `towns`.
function B.setTowns(ctx, note, map, towns, byName)
	local base = B.indexBase(map)
	ctx.townEntities, ctx.conns = {}, {}
	for i, t in ipairs(towns) do
		ctx.townEntities[i] = t.entity
	end
	for _, c in ipairs(note.connections or {}) do
		local a, b = byName[c.a], byName[c.b]
		if a and b then
			ctx.conns[#ctx.conns + 1] = { a - 1 + base, b - 1 + base }
		end
	end
	ctx.report.connections = #ctx.conns
end

return B
