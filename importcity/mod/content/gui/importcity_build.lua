-- RealMap building blocks for the automatic generation (`importcity_auto.lua`, DECISION-012),
-- from the note <userdata>/importcity/<map>.lua written by the app:
--  - industries, built like the Map Editor does (`createIndustries` + `createIndustryProposal`) and
--    named (`industries[i].name`, FACT-024);
--  - roads between the town pairs the app chose (`connections`), by the game's own command (its
--    routing; it also links the industries), its wider country roads then rebuilt as the small
--    (2-lane) country road of the map's year (`simplifyRoads`);
--  - the industries the command linked, counted for the report (`industryAccess`);
--  - the main railway (`rail.lines`): track segments along the points, a few at a time; a refused
--    piece is tried segment by segment, then skipped and counted, with the game's reason.
-- Each block calls `nextStep()` once its commands have answered (callbacks).

local i18n = ug_require "importcity::/gui/importcity_i18n.lua"

local B = {}

--- The roads between towns: the game's connection command takes no road type and may lay medium or
--- large country roads; they are rebuilt as the small one of the year (2 lanes): dirt until 1940,
--- tarmac from 1940 (each template's `availability`; the old ones no longer exist after 1940).
local ROAD_OLD_SMALL = "::/infrastructure/street/country/country_old_small.street_template"
local ROAD_NEW_SMALL = "::/infrastructure/street/country/country_new_small.street_template"
local ROAD_NEW_FROM = 1940
--- Road edges replaced in one proposal.
local ROAD_CHUNK = 20
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
				if job.item then
					ctx.built[#ctx.built + 1] = { name = job.item.name, x = job.item.x, y = job.item.y, onWater = job.item.onWater == true }
				end
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

--- The game's town connection command (its routing; it also links the existing industries). Sent
--- even without a town pair (separate networks, a town with only its industry): the industries
--- still get their roads.
function B.connect(ctx, nextStep)
	if #ctx.townEntities == 0 then
		return nextStep()
	end
	api.cmd.sendCommand(api.cmd.makeTownConnectWithIndustriesCmd(ctx.townEntities, ctx.conns, false), function(_, success, entities)
		ctx.report.roadsOk = ctx.report.roadsOk and success
		-- What it built ({entity, revision} pairs): candidates for `simplifyRoads`.
		ctx.roadEntities = type(entities) == "table" and entities or {}
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
	-- `retryAs`: the refused edge tried once more as a bridge, or as a tunnel when it lies in the
	-- cutting under a road (`lowered`, B.railCrossings).
	local k, retryUntil, prevNode, retryAs = 1, 0, nil, nil
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
			local kind = retryAs or pts[i].kind or "n"
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
					local kind = retryAs or pts[i].kind
					if kind == "b" then
						ctx.report.railBridgeEdges = ctx.report.railBridgeEdges + 1
					elseif kind == "t" then
						ctx.report.railTunnelEdges = ctx.report.railTunnelEdges + 1
					end
				end
				prevNode = addedEnd(res)
				k = last
				retryAs = nil
			elseif n > 1 then
				-- Same start again, one edge at a time.
				retryUntil = last
			elseif not retryAs and (pts[k].kind or "n") == "n" and pts[k].lowered and tunnel() then
				retryAs = "t"
			elseif not retryAs and (pts[k].kind or "n") == "n" and not pts[k].lowered and bridge() then
				retryAs = "b"
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
				retryAs = nil
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
		built = {},
		report = {
			roadsOk = true, connections = 0, industries = 0, industriesMissing = 0, renamed = 0,
			accessOk = 0, accessMissing = 0,
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

--- The street template of a road edge (its BASE_EDGE `roadTemplate`), or nil.
local function edgeTemplate(base)
	local ok, t = pcall(function()
		return base.roadTemplate
	end)
	return ok and type(t) == "string" and t or nil
end

--- An industry with a public road (not only its own `ind_*` access) this close (game m) counts as
--- linked by the game's connection command.
local ACCESS_NEAR_M = 250

--- Road edges (not track) within `r` of x, y: { base, template } (searched like `simplifyRoads`,
--- by both component types).
local function roadEdgesNear(x, y, r)
	local out, seen = {}, {}
	for _, ct in ipairs({ "BASE_EDGE_STREET", "BASE_EDGE" }) do
		local ok, list = pcall(function()
			return api.engine.util.octree.findEntitiesInCircle(vec2(x, y), r, api.type.ComponentType[ct])
		end)
		for _, e in ipairs(ok and type(list) == "table" and list or {}) do
			if not seen[e] then
				seen[e] = true
				local base = comp(e, "BASE_EDGE")
				local name = base and edgeTemplate(base)
				if name and name:find("/street/", 1, true) then
					out[#out + 1] = { base = base, template = name }
				end
			end
		end
	end
	return out
end

--- True when a node of a public road (not an industry's own access) is within `r` of x, y.
local function publicRoadNear(x, y, r)
	for _, e in ipairs(roadEdgesNear(x, y, r)) do
		if not e.template:find("/ind_", 1, true) then
			for _, n in ipairs({ e.base.node0, e.base.node1 }) do
				local c = type(n) == "number" and comp(n, "BASE_NODE") or nil
				local p = c and c.position
				if p and math.sqrt((p.x - x) ^ 2 + (p.y - y) ^ 2) <= r then
					return true
				end
			end
		end
	end
	return false
end

--- Under a road (DECISION-035): the track at least this far (game m) below the road at the
--- crossing, in a tunnel over the road's width plus this on each side.
local CROSS_DEPTH_M = 15
local CROSS_HALF_M = 80
--- The line's steepest game grade when the note does not give it.
local CROSS_GRADE = 0.025
--- Two crossings closer than this (game m) along the line are one.
local CROSS_MERGE_M = 30
--- A tunnel mouth, and the cutting after it, keep this much (game m, plus the cutting's depth: its
--- side slopes) from every road: a road met at a sharp angle, or another road nearby, makes the
--- tunnel longer. Not more: a track running beside a road at ground level needs no tunnel.
local CROSS_CLEAR_M = 10
--- A tunnel goes at most this far (game m) from its road on each side.
local CROSS_MAX_HALF_M = 300
--- Two tunnels with less than this (game m) of cutting between them become one.
local CROSS_JOIN_M = 150
--- A segment longer than this gets a node under the road (the app's nodes are ~100 m apart: the
--- flat bottom already holds a node on each side).
local CROSS_SPLIT_M = 140

--- Distance (game m) from x, y to the nearest road edge (taken straight between its nodes) within `r`,
--- or nil when none.
local function roadDistance(x, y, r)
	local best
	for _, e in ipairs(roadEdgesNear(x, y, r)) do
		local n0 = type(e.base.node0) == "number" and comp(e.base.node0, "BASE_NODE") or nil
		local n1 = type(e.base.node1) == "number" and comp(e.base.node1, "BASE_NODE") or nil
		local p, q = n0 and n0.position, n1 and n1.position
		if p and q then
			local dx, dy = q.x - p.x, q.y - p.y
			local l2 = dx * dx + dy * dy
			local t = l2 > 0 and math.max(0, math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / l2)) or 0
			local d = math.sqrt((p.x + t * dx - x) ^ 2 + (p.y + t * dy - y) ^ 2)
			if best == nil or d < best then
				best = d
			end
		end
	end
	return best
end

--- Point and unit tangent at `t` on the edge a → b laid as `B.line` lays it (Hermite curve, tangents
--- = unit tangent × length); the straight chord when a node has no tangent.
local function onEdge(a, b, t)
	local az, bz = a.z or 0, b.z or 0
	if a.tx == nil or b.tx == nil then
		local dx, dy, dz = b.x - a.x, b.y - a.y, bz - az
		local d = math.sqrt(dx * dx + dy * dy + dz * dz)
		return a.x + t * dx, a.y + t * dy, az + t * dz, dx / d, dy / d, dz / d
	end
	local L = math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2 + (bz - az) ^ 2)
	local t2, t3 = t * t, t * t * t
	local h00, h10, h01, h11 = 2 * t3 - 3 * t2 + 1, t3 - 2 * t2 + t, -2 * t3 + 3 * t2, t3 - t2
	local d00, d10, d01, d11 = 6 * t2 - 6 * t, 3 * t2 - 4 * t + 1, -6 * t2 + 6 * t, 3 * t2 - 2 * t
	local function at(pa, pb, ta, tb)
		return h00 * pa + h10 * L * ta + h01 * pb + h11 * L * tb, d00 * pa + d10 * L * ta + d01 * pb + d11 * L * tb
	end
	local x, dx = at(a.x, b.x, a.tx, b.tx)
	local y, dy = at(a.y, b.y, a.ty, b.ty)
	local z, dz = at(az, bz, a.tz or 0, b.tz or 0)
	local d = math.sqrt(dx * dx + dy * dy + dz * dz)
	return x, y, z, dx / d, dy / d, dz / d
end

--- Where segments a→b and c→d cross: t along a→b, u along c→d (0..1), or nil.
local function segmentHit(ax, ay, bx, by, cx, cy, dx, dy)
	local rx, ry, sx, sy = bx - ax, by - ay, dx - cx, dy - cy
	local den = rx * sy - ry * sx
	if math.abs(den) < 1e-9 then
		return nil
	end
	local t = ((cx - ax) * sy - (cy - ay) * sx) / den
	local u = ((cx - ax) * ry - (cy - ay) * rx) / den
	if t < 0 or t > 1 or u < 0 or u > 1 then
		return nil
	end
	return t, u
end

--- The roads are built before the railway (DECISION-035) and the game's track proposal does not
--- cross them: find where the designed line `pts` crosses an existing street, lower the profile
--- there to CROSS_DEPTH_M under the road, rising back at most `grade` (the line's steepest game
--- grade) on both sides, and make the edges around the road a tunnel. `pts` is changed in place
--- (heights, kinds, tangents) before `B.line` lays it.
function B.railCrossings(ctx, pts, grade)
	grade = (type(grade) == "number" and grade > 0) and grade or CROSS_GRADE
	if #pts < 2 then
		return
	end
	local along = { 0 }
	for i = 2, #pts do
		local a, b = pts[i - 1], pts[i]
		along[i] = along[i - 1] + math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2)
		if a.z == nil then
			a.z = height(a.x, a.y)
		end
	end
	if pts[#pts].z == nil then
		pts[#pts].z = height(pts[#pts].x, pts[#pts].y)
	end
	-- Every crossing with an existing street (the edge between its two nodes, taken straight).
	local crossings = {}
	for i = 1, #pts - 1 do
		local a, b = pts[i], pts[i + 1]
		local len = along[i + 1] - along[i]
		for _, e in ipairs(roadEdgesNear((a.x + b.x) / 2, (a.y + b.y) / 2, len / 2 + 80)) do
			local n0 = type(e.base.node0) == "number" and comp(e.base.node0, "BASE_NODE") or nil
			local n1 = type(e.base.node1) == "number" and comp(e.base.node1, "BASE_NODE") or nil
			local p, q = n0 and n0.position, n1 and n1.position
			if p and q then
				local t, u = segmentHit(a.x, a.y, b.x, b.y, p.x, p.y, q.x, q.y)
				if t then
					local s = along[i] + t * len
					local z = (p.z or height(p.x, p.y)) + u * ((q.z or height(q.x, q.y)) - (p.z or height(p.x, p.y)))
					local merged = false
					for _, c in ipairs(crossings) do
						if math.abs(c.s - s) < CROSS_MERGE_M then
							c.z = math.min(c.z, z)
							merged = true
						end
					end
					if not merged then
						crossings[#crossings + 1] = { s = s, z = z, x = a.x + t * (b.x - a.x), y = a.y + t * (b.y - a.y) }
					end
				end
			end
		end
	end
	if #crossings == 0 then
		return
	end
	-- Lowered profile: under each crossing, rising back at the line's grade (never raised). A road
	-- met on a bridge (over water or a valley) already passes under the track: left alone.
	local changed = {}
	local kept = {}
	for _, c in ipairs(crossings) do
		local onBridge = false
		for i = 1, #pts - 1 do
			if pts[i].kind == "b" and along[i + 1] >= c.s - CROSS_HALF_M and along[i] <= c.s + CROSS_HALF_M then
				onBridge = true
			end
		end
		if onBridge then
			ctx.log(string.format("rail over the road on a bridge at %d, %d", math.floor(c.x), math.floor(c.y)))
		else
			kept[#kept + 1] = c
		end
	end
	crossings = kept
	if #crossings == 0 then
		return
	end
	-- A long segment gets a node under the road, on the curve the track will follow (a node on the
	-- chord of a curved edge makes a kink: « Courbure excessive »). Last crossing first: the
	-- distances before an insertion stay right; `along` grows with `pts`.
	table.sort(crossings, function(p, q)
		return p.s > q.s
	end)
	for _, c in ipairs(crossings) do
		for i = 1, #along - 1 do
			if along[i] <= c.s and c.s < along[i + 1] then
				if along[i + 1] - along[i] > CROSS_SPLIT_M and along[i] + 5 < c.s and c.s < along[i + 1] - 5 then
					local a, b = pts[i], pts[i + 1]
					local x, y, z, tx, ty, tz = onEdge(a, b, (c.s - along[i]) / (along[i + 1] - along[i]))
					table.insert(pts, i + 1, { x = x, y = y, z = z, tx = tx, ty = ty, tz = tz, kind = a.kind })
					table.insert(along, i + 1, c.s)
					ctx.report.railSegments = ctx.report.railSegments + 1
				end
				break
			end
		end
	end
	along = { 0 }
	for i = 2, #pts do
		along[i] = along[i - 1] + math.sqrt((pts[i].x - pts[i - 1].x) ^ 2 + (pts[i].y - pts[i - 1].y) ^ 2)
	end
	-- Each crossing: the track flat at `bottom` from node `lo` to node `hi` (the road and
	-- CROSS_HALF_M on each side), rising back at the line's grade on both sides; the tunnel starts
	-- over the same nodes and may grow (below).
	local spans = {}
	for _, c in ipairs(crossings) do
		local lo, hi = 1, #pts
		for i = 1, #pts do
			if along[i] <= c.s - CROSS_HALF_M then
				lo = i
			end
		end
		for i = #pts, 1, -1 do
			if along[i] >= c.s + CROSS_HALF_M then
				hi = i
			end
		end
		spans[#spans + 1] = { lo = lo, hi = hi, flatLo = lo, flatHi = hi, bottom = c.z - CROSS_DEPTH_M, c = c }
	end
	-- Highest track allowed at node i: under every road, each with its own ramp (a long tunnel under
	-- several roads climbs back between them instead of staying at the deepest bottom).
	local limits = {}
	for i = 1, #pts do
		local limit = math.huge
		for _, sp in ipairs(spans) do
			local d = i < sp.flatLo and along[sp.flatLo] - along[i] or i > sp.flatHi and along[i] - along[sp.flatHi] or 0
			limit = math.min(limit, sp.bottom + grade * d)
		end
		limits[i] = limit
	end
	local function cutAt(i)
		return pts[i].z - limits[i]
	end
	local function tooClose(i)
		local r = CROSS_CLEAR_M + math.max(0, cutAt(i))
		local d = roadDistance(pts[i].x, pts[i].y, r)
		return d ~= nil and d < r
	end
	-- The mouth moves out while it, or the cutting after it, comes too close to a road (never onto
	-- a bridge, never further than CROSS_MAX_HALF_M).
	local function extend(sp, dir)
		local j = dir < 0 and sp.lo or sp.hi
		while true do
			local edge = dir < 0 and j - 1 or j
			if j + dir < 1 or j + dir > #pts or pts[edge].kind == "b" or math.abs(along[j + dir] - sp.c.s) > CROSS_MAX_HALF_M then
				break
			end
			local near = false
			local k = j
			while k >= 1 and k <= #pts and cutAt(k) > 0.5 do
				if tooClose(k) then
					near = true
					break
				end
				k = k + dir
			end
			if not near then
				break
			end
			j = j + dir
			if dir < 0 then
				sp.lo = j
			else
				sp.hi = j
			end
		end
	end
	for _, sp in ipairs(spans) do
		extend(sp, -1)
		extend(sp, 1)
	end
	-- Tunnels a short cutting apart: one tunnel.
	table.sort(spans, function(p, q)
		return p.lo < q.lo
	end)
	local joined = {}
	for _, sp in ipairs(spans) do
		local last = joined[#joined]
		if last and along[sp.lo] - along[last.hi] < CROSS_JOIN_M then
			last.hi = math.max(last.hi, sp.hi)
			last.n = last.n + 1
		else
			joined[#joined + 1] = { lo = sp.lo, hi = sp.hi, c = sp.c, n = 1 }
		end
	end
	for _, sp in ipairs(joined) do
		for i = sp.lo, sp.hi - 1 do
			pts[i].kind = "t"
		end
		ctx.log(string.format("rail under %d road(s) at %d, %d: tunnel %d m, mouths %.1f m and %.1f m below the designed line",
			sp.n, math.floor(sp.c.x), math.floor(sp.c.y), math.floor(along[sp.hi] - along[sp.lo]), math.max(0, cutAt(sp.lo)), math.max(0, cutAt(sp.hi))))
	end
	for i = 1, #pts do
		if pts[i].z > limits[i] then
			pts[i].z = limits[i]
			pts[i].lowered = true
			changed[i] = true
		end
	end
	-- Tangents of the lowered nodes from their neighbours (unit vector, as the app's).
	local around = {}
	for i in pairs(changed) do
		around[i], around[math.max(1, i - 1)], around[math.min(#pts, i + 1)] = true, true, true
	end
	for i in pairs(around) do
		local a, b = pts[math.max(1, i - 1)], pts[math.min(#pts, i + 1)]
		local dx, dy, dz = b.x - a.x, b.y - a.y, b.z - a.z
		local d = math.sqrt(dx * dx + dy * dy + dz * dz)
		if d > 0 then
			pts[i].tx, pts[i].ty, pts[i].tz = dx / d, dy / d, dz / d
		end
	end
	ctx.report.railCrossings = (ctx.report.railCrossings or 0) + #crossings
end

--- Count the built land industries the game's command linked (a public road within
--- ACCESS_NEAR_M), naming the others for the report; nothing is laid (DECISION-033). Water
--- industries are never linked by the game (« Street targets empty »): left out.
function B.industryAccess(ctx, nextStep)
	local r = ctx.report
	r.accessLand, r.accessNames = 0, {}
	for _, ind in ipairs(ctx.built) do
		if not ind.onWater then
			r.accessLand = r.accessLand + 1
			if publicRoadNear(ind.x, ind.y, ACCESS_NEAR_M) then
				r.accessOk = r.accessOk + 1
			else
				r.accessMissing = r.accessMissing + 1
				r.accessNames[#r.accessNames + 1] = tostring(ind.name)
				ctx.log("industry without a road nearby: " .. tostring(ind.name))
			end
		end
	end
	nextStep()
end

--- Rebuild the wider country roads the connection command laid (medium, large) as the small country
--- road of the year: same nodes, curves, bridges and tunnels (edgesToRemove + edgesToAdd, as the
--- game's `mission/tasks/auto_builder/electrify.tl`). The new edge is made fresh from the old one's
--- geometry, like the rail: a copy of the old component keeps its per-lane data (`laneConfig`,
--- `edgeDecorations`) and the engine aborts on it (« lc.segment0 not found », seen in game).
--- Small country roads, town streets and industry access roads are left alone. ROAD_CHUNK edges per
--- proposal; a refused one is tried edge by edge, a refused edge stays as the game built it.
function B.simplifyRoads(ctx, nextStep)
	local r = ctx.report
	r.roadEdges, r.roadEdgesSimple = 0, 0
	local roadName = year() >= ROAD_NEW_FROM and ROAD_NEW_SMALL or ROAD_OLD_SMALL
	local okT, template = pcall(function()
		return api.res.streetTemplateRep.get(api.res.streetTemplateRep.find(roadName))
	end)
	if not okT or template == nil then
		ctx.log("small road template not found: " .. roadName)
		return nextStep()
	end
	ctx.log("country roads rebuilt as: " .. roadName)
	-- Candidate edges: what the connection command answered, and the whole map from the octree (as
	-- the game's `mission/name_util.tl` searches it); `forEachEntityWithComponent` refuses street
	-- edges (« Cannot loop over this component type », seen in game).
	local edges, seen, sampled = {}, {}, false
	local function consider(entity)
		if type(entity) ~= "number" or seen[entity] then
			return
		end
		seen[entity] = true
		local base = comp(entity, "BASE_EDGE")
		local name = base and edgeTemplate(base)
		if name and not sampled then
			sampled = true
			ctx.log("first road edge template: " .. name)
		end
		if name and name:find("/country/country_", 1, true) and not name:find("_small", 1, true) then
			edges[#edges + 1] = { entity = entity, base = base }
		end
	end
	for _, e in ipairs(ctx.roadEntities or {}) do
		consider(type(e) == "table" and e[1] or e)
	end
	local fromCommand = #edges
	for _, ct in ipairs({ "BASE_EDGE_STREET", "BASE_EDGE" }) do
		local ok, list = pcall(function()
			return api.engine.util.octree.findEntitiesInCircle(vec2(0, 0), 1e10, api.type.ComponentType[ct])
		end)
		if ok and type(list) == "table" then
			for _, e in ipairs(list) do
				consider(e)
			end
		else
			ctx.log("octree " .. ct .. " not searched: " .. tostring(list))
		end
	end
	ctx.log(string.format("road edges: %d from the command, %d in all", fromCommand, #edges))
	r.roadEdges = #edges
	ctx.log(string.format("country road edges to simplify: %d", #edges))
	local k, retryUntil = 1, 0
	local function step()
		if k > #edges then
			return nextStep()
		end
		local n = k < retryUntil and 1 or ROAD_CHUNK
		local last = math.min(#edges, k + n - 1)
		local proposal = api.type.SimpleProposal.new()
		local remove, add = {}, {}
		for i = k, last do
			local e = edges[i]
			remove[#remove + 1] = e.entity
			local seg = api.type.SegmentAndEntity.new()
			seg.entity = -(i - k + 1)
			seg.type = 0 -- street
			-- A fresh edge with the old one's geometry (its component is read-only in game anyway).
			local old, base = e.base, seg.comp
			for _, f in ipairs({ "node0", "node1", "position0", "position1", "tangent0", "tangent1", "type", "typeIndex", "roadType" }) do
				base[f] = old[f]
			end
			base.laneConfigs = template.laneConfigs
			base.roadTemplate = roadName
			base.roadStyle = template.streetStyle
			add[#add + 1] = seg
		end
		proposal.streetProposal.edgesToRemove = remove
		proposal.streetProposal.edgesToAdd = add
		local reason = n == 1 and refusal(proposal) or nil
		api.cmd.sendCommand(api.cmd.makeWorldBuildProposalCmd(proposal, nil, false, false), function(_, success)
			if success then
				r.roadEdgesSimple = r.roadEdgesSimple + (last - k + 1)
				k = last + 1
			elseif n > 1 then
				retryUntil = last + 1
			else
				ctx.log("road edge " .. tostring(edges[k].entity) .. " kept: " .. tostring(reason))
				k = k + 1
			end
			step()
		end)
	end
	step()
end

return B
