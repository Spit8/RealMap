#!/usr/bin/env python3
"""Offline simulation of the importcity mod (lupa) against a stubbed TF3 API.

Plays the automatic generation (DECISION-012): the app's request.lua is picked up by the pump, the
mod checks the open map, then builds heightmap > biomes > towns > industries > roads > rail,
writing status.lua at each stage; the game answers commands later (a queue) and the progress
window is rendered so its MapPreviewComp computes the imported map (onReady), as in the game.
Checks: an explicit error outside the Map Editor and for a map of the wrong size, the stage and
command order, import settings (heightmap min/max, biome files, generator), towns created then
sized, industries named, 0-based town pairs, a refused railway piece retried then skipped with the
game's reason, a request run once, the request found at start left alone and a cancelled one ignored
(no clock), every decision logged, alive.lua written, the window's pump when the button's is missing.

  pip install lupa
  python importcity/tools/sim_mod.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from lupa import lua54 as L

MOD = Path(__file__).resolve().parents[1] / "mod" / "content"


def check_generated_script() -> None:
    """The TFUI script must not use a `handlers` it never defines: TFUI only adds
    `local handlers = ug_require …` when a prop is a handler, and the game's UI then crashes on
    `attempt to index global 'handlers'` (seen in game, 2026-10-31)."""
    script = (MOD / "gui" / "main_gui.script.lua").read_text(encoding="utf-8")
    uses = re.search(r"(?<![\w.\")])handlers\.", script)
    if uses and "local handlers =" not in script:
        raise SystemExit("main_gui.script.lua uses the global 'handlers' without defining it")
    # One window only (DECISION-013): the TFUI window is gone, the button opens the mod's own.
    if "ImportcityMainWindow" in script or "openWindow()" not in script:
        raise SystemExit("main_gui.script.lua must only hold the RealMap button opening the mod's window")


def check_no_clock() -> None:
    """Game updates may change os.time (DECISION-024): the request logic must not depend on it."""
    for name in ("importcity_auto.lua", "main_gui.handlers.lua"):
        if "os.time" in (MOD / "gui" / name).read_text(encoding="utf-8"):
            raise SystemExit(f"{name} uses os.time")


def main() -> int:
    check_generated_script()
    check_no_clock()
    rt = L.LuaRuntime()
    rt.globals().MODDIR = str(MOD).replace("\\", "/")
    ok = rt.execute(r'''
SIM = { queue = {}, cmds = {}, saves = {}, names = {}, nodes = {}, nextEntity = 5000, stages = {},
        editor = true, tiles = { 32, 32 }, gameTowns = {}, constructions = {}, logs = {}, missing = {},
        streetEdges = {} }
local _print = print
print = function(...) SIM.logs[#SIM.logs + 1] = table.concat({ ... }, " ") end
--- A line logged by the mod (stdout.txt in the game) matching `pattern`.
function SIM.logged(pattern)
  for _, l in ipairs(SIM.logs) do if l:match(pattern) then return l end end
end
local function file(p) local f = assert(io.open(MODDIR .. "/" .. p, "r")); local s = f:read("a"); f:close(); return s end

-- React stub: hook states kept per call position, onStep callbacks collected at each render.
local hooks, hookAt, steps = {}, 0, {}
local react = {
  useState = function(init)
    hookAt = hookAt + 1
    local k = hookAt
    if hooks[k] == nil then hooks[k] = { v = init } end
    return { old = function() return hooks[k].v end, set = function(_, v) hooks[k].v = v end }
  end,
  onStep = function(fn) steps[#steps + 1] = fn end,
  RegisterWrapperRecipe = function(name, _, fn) return { name = name, fn = fn } end,
}
local function node(kind) return function(props) props = props or {}; props.kind = kind; return props end end
local builtin = { Window = node("Window"), BoxLayout = node("BoxLayout"), TextView = node("TextView"),
                  MapPreviewComp = node("MapPreviewComp"), type = { Orientation = { Vertical = 1 } } }
local globals = { getDefaultWindowApi = function()
  return { addSingletonWindow = function(r) SIM.window = r end, moveSingletonWindowToFront = function() end }
end }
local paramUtil = { getScriptParamDefaultValueIndex = function(_, i) return i end }
function ug_require(path)
  if path == "::/gui/main/react.lua" then return react end
  if path == "::/gui/main/builtin.lua" then return builtin end
  if path == "::/gui/main/game_react_globals.tl" then return globals end
  if path == "/gui/main/script_param_util.tl" then return paramUtil end
  local rel = assert(path:match("^importcity::/(.*)$"), "unexpected require " .. path)
  return assert(load(file(rel), rel))()
end

local function find(tree, kind)
  if type(tree) ~= "table" then return nil end
  if tree.kind == kind then return tree end
  for _, v in pairs(tree) do
    if type(v) == "table" then local f = find(v, kind); if f then return f end end
  end
end
--- Render the progress window twice (the preview appears one step after), answer its preview.
function SIM.render()
  if not SIM.window then return end
  for _ = 1, 2 do
    hookAt, steps = 0, {}
    local tree = SIM.window.fn({})
    for _, fn in ipairs(steps) do fn() end
    local p = find(tree, "MapPreviewComp")
    if p then
      SIM.previews = (SIM.previews or 0) + 1
      SIM.lastPreview = p
      p.onReady({ computed = p.mode })
      return true
    end
  end
end

NOTE = {
  name = "Test", createdAt = 42, tiles = { 32, 32 }, mapSize = "Petite (1 : 1)", minHeight = -9, maxHeight = 439,
  waterLevel = 0, heightmap = "Test", economy = "temperate",
  biomes = { biomes = "Test_biomes", mountains = "Test_mountains", rivers = "Test_rivers" },
  towns = { { name = "Lyon", x = 0, y = 0, capacity = 900, shares = { res = 0.4, com = 0.35, ind = 0.25 },
              needs = { com = { "vegetables", "unknown" }, ind = { "planks" } } }, { name = "Bron", x = 3000, y = 0, capacity = 300 },
            { name = "Givors", x = 0, y = -4000, capacity = 200 } },
  connections = { { a = "Lyon", b = "Bron" }, { a = "Lyon", b = "Givors" } },
  industries = {
    { tag = "quarry", x = 3500, y = 800, angle = 0, onWater = false, fileName = "::/industries/quarry/quarry.con", name = "Carrière de Bron" },
    { tag = "farm", x = -2000, y = 1500, angle = 0, onWater = false, fileName = "::/industries/farm/farm.con", name = "Ferme de Lyon" },
  },
  -- A designed line (app, DECISION-014): height of the profile, unit tangent, kind of the next edge.
  rail = { lines = { (function()
    local pts = {}
    for i = 0, 8 do
      local x = -4000 + i * 1000
      pts[#pts + 1] = { x = x, y = 100, z = 30, tx = 1, ty = 0, tz = 0,
                        kind = (x == 1000 and "b") or (x == -2000 and "t") or "n" }
    end
    return pts
  end)() } },
}
-- towns_industries: the game creates them in reverse order (the mod must use the game's order).
TOWNS_FILE = { towns = { { name = "Lyon", position = { x = 0, y = 0 } }, { name = "Bron", position = { x = 3000, y = 0 } },
                         { name = "Givors", position = { x = 0, y = -4000 } } } }
-- The railway edge starting at FAIL_X crosses a river (refused unless a bridge: the app designed it
-- as one), the one at FAIL_DRY is refused whatever is tried (too steep, say).
FAIL_X = 1000
FAIL_DRY = 3000

local function rec(kind) return function(...) return { kind = kind, args = { ... } } end end
local function newRecord() return { new = function() return {} end } end
local function now() return os.time() end
api = {
  -- The game's language (FACT-031 unknown format): a table with a code, French here.
  util = { getLanguage = function() return { code = SIM.lang or "fr_FR" } end },
  type = {
    Vec2f = { new = function(x, y) return { x = x, y = y } end },
    Vec3f = { new = function(x, y, z) return { x = x, y = y, z = z } end },
    Map = { Industry = newRecord(), Town = newRecord() },
    Context = newRecord(), ImportExportHeightmapMode = newRecord(), ImportBiomesMode = newRecord(),
    SimpleProposal = { new = function() return { streetProposal = {} } end },
    NodeAndEntity = { new = function() return { comp = {} } end },
    -- As in game: assigning `comp` stores a writable copy of the component (electrify.tl edits it there).
    SegmentAndEntity = { new = function()
      local fields = { comp = {} }
      return setmetatable({}, {
        __index = fields,
        __newindex = function(_, k, v)
          if k == "comp" and type(v) == "table" then
            local copy = {}
            for kk, vv in pairs(getmetatable(v) and getmetatable(v).fields or v) do copy[kk] = vv end
            v = copy
          end
          fields[k] = v
        end,
      })
    end },
    ComponentType = { TOWN = "TOWN", CONSTRUCTION = "CONSTRUCTION", BASE_NODE = "BASE_NODE",
                      BASE_EDGE = "BASE_EDGE", BASE_EDGE_STREET = "BASE_EDGE_STREET" },
    enum = { BaseEdgeType = { NORMAL = "NORMAL", BRIDGE = "BRIDGE", TUNNEL = "TUNNEL" }, RoadType = { TRACK = "TRACK", STREET = "STREET" } },
  },
  gui = {
    game = { isMapEditor = function() return SIM.editor end },
    map = { reloadMaterialIndexManagerPipeline = function() SIM.reloads = (SIM.reloads or 0) + 1 end },
    byId = { setVisible = function() end },
  },
  engine = {
    terrain = {
      -- As in the game: without the heightmap the map reports 0 x 0 tiles.
      makeMapFromGame = function(withHeightmap)
        local towns = {}
        for i, t in ipairs(SIM.gameTowns) do towns[i] = t end
        local n = withHeightmap and SIM.tiles or { 0, 0 }
        return { numTilesX = n[1], numTilesY = n[2], towns = towns, industries = SIM.gameIndustries or {} }
      end,
      getBoundingBox = function()
        local hx, hy = SIM.tiles[1] * 128, SIM.tiles[2] * 128
        return { min = { x = -hx, y = -hy }, max = { x = hx, y = hy } }
      end,
      getHeightAt = function(p) return 10 + p.x / 1000 end,
      isOnWater = function(p) return p.x > FAIL_X + 1 and p.x < FAIL_X + 999 end,
      isValidCoordinate = function() return true end,
    },
    mapgen = {
      getDefaultTownConnections = function() return { { 0, 1 }, { 1, 2 } } end,
      createTowns = function(_, towns) return { toAdd = towns, toRemove = {} } end,
      createIndustries = function(_, list)
        local toAdd = {}
        for i = #list, 1, -1 do
          toAdd[#toAdd + 1] = { fileName = list[i].fileName, transf = { [13] = list[i].pos.x + 20, [14] = list[i].pos.y - 10 } }
        end
        return { toAdd = toAdd, toRemove = {} }
      end,
    },
    util = {
      -- Street edges (the town connection command lays them), found by the octree.
      octree = { findEntitiesInCircle = function(c, r, ct)
        local ids = {}
        if ct == "BASE_EDGE_STREET" or ct == "BASE_EDGE" then
          for e, s in pairs(SIM.streetEdges) do
            if not s.at or math.sqrt((s.at[1] - c.x) ^ 2 + (s.at[2] - c.y) ^ 2) <= r then ids[#ids + 1] = e end
          end
        end
        table.sort(ids)
        return ids
      end },
      getWorld = function() return 1 end,
      getYear = function() return 1925 end,
      proposal = {
        createIndustryProposal = function(_, info) return { industry = info } end,
        -- The game's diagnosis of a track proposal (reported only when it is refused).
        makeProposalData = function() return { errorState = { messages = { "Trop pentu" }, critical = true } } end,
      },
    },
    -- As in game: edges cannot be looped over this way.
    forEachEntityWithComponent = function(fn, ct)
      if ct == "BASE_EDGE_STREET" or ct == "BASE_EDGE" then error("Cannot loop over this component type") end
    end,
    getComponent = function(e, ct)
      if ct == "BASE_EDGE" and SIM.streetEdges[e] then
        local s = SIM.streetEdges[e]
        -- As in game: the component is read-only and carries per-lane data of its own template.
        local fields = { roadTemplate = s.roadTemplate, type = s.type, node0 = e * 10, node1 = e * 10 + 1, laneConfigs = { "old" },
                         laneConfig = { "old" }, edgeDecorations = { { 0, false } } }
        return setmetatable({}, {
          fields = fields,
          __index = fields,
          __newindex = function(_, k) error("cannot write to read only member '" .. tostring(k) .. "'") end,
        })
      end
      if ct == "TOWN" and e >= 101 and e <= 199 then return { initialLandUseCapacities = { 100, 60, 40 }, sizeFactors = { 1, 1, 1 }, cargoNeeds = { { { 5, 1 } }, {}, {} } } end
      if ct == "CONSTRUCTION" and SIM.constructions[e] then return {} end
      if ct == "BASE_NODE" and SIM.nodes[e] then return { position = SIM.nodes[e] } end
      return nil
    end,
  },
  res = {
    getBaseConfig = function() return { climate = "temperate.clima", terrain = "terrain", economyId = "temperate.eco", locations = {} } end,
    climateRep = { find = function(n) return n end,
                   get = function() return { mapColoring = {}, dataMaps = { layers = { { key = "mountains" }, { key = "rivers" } } } } end },
    streetTemplateRep = { find = function(n) return n end, get = function(n) return { laneConfigs = { "lanes" }, streetStyle = "style" } end },
    bridgeTypeRep = { find = function(n) return n == "::/infrastructure/bridge/stone.bridge" and 3 or -1 end },
    cargoTypeRep = { find = function(n)
      return ({ ["::/cargos/vegetables/vegetables.cargo"] = 22, ["::/cargos/planks/planks.cargo"] = 21 })[n] or -1
    end },
    tunnelTypeRep = { find = function(n) return n == "::/infrastructure/tunnel/tunnel_a.tunnel" and 7 or -1 end },
  },
  cmd = setmetatable({
    sendCommand = function(c, cb) SIM.cmds[#SIM.cmds + 1] = c; SIM.queue[#SIM.queue + 1] = { c, cb } end,
  }, { __index = function(_, k) return rec(k) end }),
}
local USERDATA_DIRS = { towns_industries = true, heightmaps = true, mod_presets = true }
local function allowed(dir)
  if not USERDATA_DIRS[dir] then error("The directory you trying to access is not available or invalid") end
end
app = {
  res = { terrainGeneratorRep = {
    getAll = function() return { [1] = true, [2] = true } end,
    get = function(k)
      if k == 1 then return { climate = "temperate.clima", isImportGenerator = false, order = 1, params = {} } end
      return { climate = "temperate.clima", isImportGenerator = true, order = 2, params = { { key = "water", numbers = {}, defaultIndex = 3 } } }
    end,
    getName = function(k) return k == 2 and "temperate_import.gen" or "temperate.gen" end,
  } },
  getUserDataFolder = function() return "C:/Steam/userdata/1/3493540/local/" end,
  getAllHeightmaps = function() return { "Other", "Test" } end,
  getAllBiomes = function() return { "Test_biomes", "Test_mountains", "Test_rivers" } end,
  -- As the game since build 40420/40423 (FACT-034): only these folders, anything else throws.
  loadUserdata = function(dir, name)
    allowed(dir)
    if dir ~= "towns_industries" then return nil end
    if name == "Test" then return TOWNS_FILE end
    if name == "realmap_latest" then return { name = "Test" } end
    if name == "realmap_note_Test" then return NOTE end
    if name == "realmap_request" and SIM.request then return SIM.request end
    if SIM.saves[name] ~= nil then return SIM.saves[name] end
    -- A missing file: the game logs an error block (even under pcall) and returns an empty table.
    SIM.missing[name] = (SIM.missing[name] or 0) + 1
    return {}
  end,
  saveUserdata = function(dir, name, tbl)
    allowed(dir)
    if SIM.failSave == name then error("disk full") end
    SIM.saves[name] = tbl
    if name == "realmap_status" then SIM.stages[#SIM.stages + 1] = tbl.stage end
  end,
}

local COUNTRY = "::/infrastructure/street/country/"
local function answer(c)
  if c.kind == "makeTownConnectWithIndustriesCmd" then
    -- The game's roads: medium country roads (one over a bridge), a town street, an industry access.
    -- The quarry has a country road beside it; the farm only its own access stub.
    SIM.streetEdges = {
      [9001] = { roadTemplate = COUNTRY .. "country_old_medium.street_template", type = "NORMAL", at = { 3600, 850 } },
      [9002] = { roadTemplate = COUNTRY .. "country_old_medium.street_template", type = "BRIDGE", at = { 1500, 0 } },
      [9003] = { roadTemplate = "::/infrastructure/street/town/town_old_small.street_template", type = "NORMAL", at = { 150, 0 } },
      [9004] = { roadTemplate = COUNTRY .. "ind_country_old_small.street_template", type = "NORMAL", at = { 3450, 750 } },
      [9005] = { roadTemplate = COUNTRY .. "country_new_medium.street_template", type = "NORMAL", at = { 2500, 0 } },
      [9006] = { roadTemplate = COUNTRY .. "ind_country_old_small.street_template", type = "NORMAL", at = { -1850, 1350 } },
    }
    for e, s in pairs(SIM.streetEdges) do
      SIM.nodes[e * 10] = { x = s.at[1], y = s.at[2], z = 20 }
      SIM.nodes[e * 10 + 1] = { x = s.at[1] + 50, y = s.at[2], z = 20 }
    end
    -- A road across the railway's line (y = 100) at x = -500, laid before the track (DECISION-035).
    SIM.streetEdges[9007] = { roadTemplate = "::/infrastructure/street/town/town_old_small.street_template", type = "NORMAL", at = { -500, 100 } }
    SIM.nodes[90070] = { x = -500, y = -200, z = 30 }
    SIM.nodes[90071] = { x = -500, y = 400, z = 30 }
    return true, { { 9005, 1 }, { 9001, 1 } }
  end
  if c.kind == "makeWorldReplaceTerrainCmd" then SIM.replaced = (SIM.replaced or {}); SIM.replaced[#SIM.replaced + 1] = c.args[1].computed; return true, {} end
  if c.kind == "makeTownCreateCmd" then
    for i = #c.args[1], 1, -1 do
      local t = c.args[1][i]
      SIM.gameTowns[#SIM.gameTowns + 1] = { existing = 100 + #SIM.gameTowns + 1, name = t.name, pos = t.pos }
    end
    return true, {}
  end
  local sp0 = c.kind == "makeWorldBuildProposalCmd" and c.args[1].streetProposal
  if sp0 and #(sp0.edgesToRemove or {}) > 0 then
    -- A street type change (electrify.tl's way): each removed edge comes back, same nodes and type.
    for i, e in ipairs(sp0.edgesToRemove) do
      local seg, old = sp0.edgesToAdd[i], SIM.streetEdges[e]
      if not old or seg.type ~= 0 or seg.comp.roadTemplate ~= COUNTRY .. "country_old_small.street_template"
         or seg.comp.laneConfigs[1] ~= "lanes" or seg.comp.roadStyle ~= "style" or seg.comp.type ~= old.type
         or seg.comp.node0 ~= e * 10
         -- The old edge's per-lane data makes the engine abort in game (« lc.segment0 not found »).
         or seg.comp.laneConfig ~= nil or seg.comp.edgeDecorations ~= nil then
        SIM.malformed = true
        return false, {}
      end
      if e == SIM.refuseRoad then return false, {} end
    end
    for i, e in ipairs(sp0.edgesToRemove) do SIM.streetEdges[e].roadTemplate = sp0.edgesToAdd[i].comp.roadTemplate end
    return true, {}
  end
  if c.kind == "makeWorldBuildProposalCmd" then
    local p = c.args[1]
    if p.industry then
      SIM.nextEntity = SIM.nextEntity + 1
      SIM.constructions[SIM.nextEntity] = true
      return true, { { SIM.nextEntity, 0 } }
    end
    local sp = p.streetProposal
    if sp.edgesToAdd and sp.edgesToAdd[1] and sp.edgesToAdd[1].type == 0 then
      local first, lastE = sp.edgesToAdd[1].comp, sp.edgesToAdd[#sp.edgesToAdd].comp
      for _, e in ipairs(sp.edgesToAdd) do
        local c = e.comp
        if c.roadType ~= "STREET" or c.roadTemplate ~= COUNTRY .. "country_old_small.street_template"
           or c.laneConfigs[1] ~= "lanes" or c.position0 == nil or c.type == nil then
          SIM.malformed = true
          return false, {}
        end
      end
      SIM.accessRoads = SIM.accessRoads or {}
      SIM.accessRoads[#SIM.accessRoads + 1] = { from = first.node0, to = lastE.node1, edges = #sp.edgesToAdd }
      return true, {}
    end
    local bridges, tunnels = 0, 0
    local pos = {}
    for _, n in ipairs(sp.nodesToAdd or {}) do pos[n.entity] = n.comp.position end
    for e, v in pairs(SIM.nodes) do pos[e] = v end
    for _, e in ipairs(sp.edgesToAdd or {}) do
      local c = e.comp
      -- What the game's own track builder fills (FACT-027): without it, « Construction impossible ».
      if e.type ~= 1 or c.roadType ~= "TRACK" or c.type == nil or c.typeIndex == nil or c.position0 == nil or c.position1 == nil
         or c.laneConfigs[1] ~= "lanes" or not c.roadTemplate:match("simple") then
        SIM.malformed = true
        return false, {}
      end
      local a, b = pos[c.node0], pos[c.node1]
      local x0 = a.x
      -- The app's design laid as is (heights at 30, or lowered under the road: never raised), its
      -- unit tangents scaled to the edge length.
      local len = math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2 + (b.z - a.z) ^ 2)
      local norm = function(t) return math.sqrt(t.x ^ 2 + t.y ^ 2 + t.z ^ 2) end
      if a.z > 30 + 1e-6 or a.z < 14.9 or math.abs(norm(c.tangent0) - len) > 1e-6 or math.abs(norm(c.tangent1) - len) > 1e-6 then
        SIM.malformed = true
        return false, {}
      end
      if c.type == "TUNNEL" then
        if c.typeIndex ~= 7 then SIM.malformed = true; return false, {} end
        tunnels = tunnels + 1
      end
      if math.abs(x0 - FAIL_DRY) < 1 then return false, {} end
      if math.abs(x0 - FAIL_X) < 1 and not (c.type == "BRIDGE" and c.typeIndex == 3) then return false, {} end
      if c.type == "BRIDGE" then bridges = bridges + 1 end
    end
    local out, made = {}, {}
    for _, n in ipairs(sp.nodesToAdd or {}) do
      SIM.nextEntity = SIM.nextEntity + 1
      SIM.nodes[SIM.nextEntity] = n.comp.position
      made[n.entity] = SIM.nextEntity
      out[#out + 1] = { SIM.nextEntity, 0 }
    end
    local added = {}
    for _, e in ipairs(sp.edgesToAdd or {}) do
      added[#added + 1] = { comp = { node0 = made[e.comp.node0] or e.comp.node0, node1 = made[e.comp.node1] or e.comp.node1 } }
    end
    SIM.segments = (SIM.segments or 0) + #(sp.edgesToAdd or {})
    SIM.bridges = (SIM.bridges or 0) + bridges
    SIM.tunnels = (SIM.tunnels or 0) + tunnels
    return true, out, { proposal = { proposal = { addedSegments = added } } }
  end
  if c.kind == "makeEntitySetNameCmd" then SIM.names[#SIM.names + 1] = c.args[2] end
  return true, {}
end
--- Let the game run: pump ticks, window renders, command answers, until nothing moves.
function SIM.play(stepFn)
  for _ = 1, 200 do
    for _ = 1, 30 do stepFn() end
    local moved = SIM.render()
    while #SIM.queue > 0 do
      local item = table.remove(SIM.queue, 1)
      local success, entities, data = answer(item[1])
      if item[2] then item[2](data or item[1], success, entities) end
      moved = true
    end
    if not moved then return end
  end
  error("runaway")
end

handlers = ug_require("importcity::/gui/main_gui.handlers.lua")
-- 0. The « RealMap » button opens the mod's only window, with the instructions.
handlers.openWindow()
assert(SIM.window and SIM.window.name == "RealmapWindow", "the button opens the RealMap window")
hookAt, steps = 0, {}
local first = SIM.window.fn({})
assert(first.meta.class == "realmap-window", "fixed-size window class")
local texts = {}
for _, c in ipairs(first.content.children) do texts[#texts + 1] = c.text end
assert(table.concat(texts, " "):match("Générer la carte"), "instructions shown before any generation")
local pumpStep
-- The mod-area button: its icon expression installs the pump (generation runs with the window closed).
assert(handlers.buttonIcon({ onStep = function(fn) pumpStep = fn end }) == "importcity::/gui/icons/realmap.tga", "button icon path")
assert(pumpStep, "the button icon installs the pump")
local function last() return SIM.saves["realmap_status"] end
-- The mod looks before the app sends anything (no request yet: nothing left alone). The missing
-- request file is read once, then replaced by an empty one: no error flood in the game's log.
SIM.play(pumpStep)
SIM.play(pumpStep)
assert(SIM.missing.realmap_request == 1 and SIM.saves.realmap_request and next(SIM.saves.realmap_request) == nil,
       "missing request read once, then an empty one: " .. tostring(SIM.missing.realmap_request))
assert(not SIM.logged("unreadable"), "no request is not an unreadable one")

-- 1. Outside the Map Editor: explicit error, nothing built.
SIM.editor = false
SIM.request = { id = now() * 1000, name = "Test", createdAt = 42 }
SIM.play(pumpStep)
assert(last().stage == "error" and last().message:match("éditeur de cartes"), "not in editor: " .. tostring(last().message))
assert(#SIM.cmds == 0, "nothing built outside the editor")

-- 2. Wrong map size.
SIM.editor = true
SIM.tiles = { 56, 56 }
SIM.request = { id = now() * 1000 + 1, name = "Test", createdAt = 42 }
SIM.play(pumpStep)
assert(last().stage == "error" and last().message:match("56 × 56") and last().message:match("32 × 32"), "size: " .. last().message)

-- 3. The real thing.
SIM.tiles = { 32, 32 }
SIM.refuseRoad = 9005
SIM.stages = {}
SIM.request = { id = now() * 1000 + 2, name = "Test", createdAt = 42 }
SIM.play(pumpStep)
local seq = table.concat(SIM.stages, " ")
_print("stages: " .. seq)
assert(seq == "check heightmap biomes towns industries roads rail done", "stage order: " .. seq)
assert(#SIM.replaced == 2, "two terrain replacements")
local hm, bm = SIM.replaced[1], SIM.replaced[2]
assert(hm.import == true and hm.minH == -9 and hm.maxH == 439 and hm.fileName == "Test", "heightmap import settings")
assert(bm.terrainGenerator == "temperate_import.gen" and bm.biomeMap == "Test_biomes"
       and bm.layerMaps.mountains == "Test_mountains" and bm.layerMaps.rivers == "Test_rivers", "biome import settings")
assert(SIM.lastPreview.params.water == 3, "generator default parameters")
local order = {}
for _, c in ipairs(SIM.cmds) do
  if c.kind == "makeWorldReplaceTerrainCmd" then order[#order + 1] = "terrain"
  elseif c.kind == "makeTownCreateCmd" then order[#order + 1] = "towns"
  elseif c.kind == "makeTownSetInitialLandUseCapacitiesCmd" then order[#order + 1] = "size"
  elseif c.kind == "makeWorldBuildProposalCmd" and c.args[1].industry then order[#order + 1] = "industry"
  elseif c.kind == "makeTownConnectWithIndustriesCmd" then order[#order + 1] = "roads"
  elseif c.kind == "makeWorldBuildProposalCmd" and #(c.args[1].streetProposal.edgesToRemove or {}) > 0 then order[#order + 1] = "simplify"
  elseif c.kind == "makeWorldBuildProposalCmd" and (c.args[1].streetProposal.edgesToAdd or {})[1] and c.args[1].streetProposal.edgesToAdd[1].type == 0 then order[#order + 1] = "access"
  elseif c.kind == "makeWorldBuildProposalCmd" then order[#order + 1] = "rail" end
end
local cmdSeq = table.concat(order, " ")
_print("commands: " .. cmdSeq)
assert(cmdSeq:match("^terrain terrain towns size size size industry industry roads simplify simplify simplify simplify rail[ rail]*$"), "command order: " .. cmdSeq)
-- Industries linked by the game: the quarry has a road beside it, the farm only its own stub;
-- nothing is laid by the mod.
assert(SIM.accessRoads == nil, "no road laid by the mod")
assert(table.concat(last().report, " "):match("Industries reliées par le jeu : 1 / 2 ont une route ; sans route à proximité : Ferme de Lyon"), "access report")
-- Medium country roads (4 lanes) replaced by the simple old one, in one proposal; the edge refused
-- (SIM.refuseRoad) fails the batch, then each edge alone: it stays, the others pass.
for e, want in pairs({ [9001] = "country_old_small", [9002] = "country_old_small", [9003] = "town/town_old_small",
                       [9004] = "ind_country_old_small", [9005] = "country_new_medium" }) do
  assert(SIM.streetEdges[e].roadTemplate:find(want, 1, true), "road " .. e .. ": " .. SIM.streetEdges[e].roadTemplate)
end
assert(table.concat(last().report, " "):match("2 / 3 tronçon"), "simple roads report")
local conn
for _, c in ipairs(SIM.cmds) do if c.kind == "makeTownConnectWithIndustriesCmd" then conn = c end end
-- Game order: Givors (101), Bron (102), Lyon (103). Lyon–Bron = {2, 1}, Lyon–Givors = {2, 0}.
assert(conn.args[2][1][1] == 2 and conn.args[2][1][2] == 1 and conn.args[2][2][1] == 2 and conn.args[2][2][2] == 0, "0-based town pairs")
assert(conn.args[3] == false, "fresh roads")
table.sort(SIM.names)
assert(table.concat(SIM.names, "|") == "Carrière de Bron|Ferme de Lyon", "names")
assert(not SIM.malformed, "every track segment is filled like the game's")
-- 9 edges once a node is added under the road at x = -500: the two edges around it in a tunnel,
-- the track 15 m under the road there (15 m), back to its height within the grade.
assert(SIM.segments == 8 and SIM.bridges == 1 and SIM.tunnels == 3, "8 of 9 railway edges, the river one a bridge, three tunnels: " .. SIM.segments .. " " .. SIM.tunnels)
local under = false
for _, p in pairs(SIM.nodes) do if math.abs(p.x + 500) < 1e-6 and math.abs(p.y - 100) < 1e-6 and math.abs(p.z - 15) < 1e-6 then under = true end end
assert(under, "a track node 15 m under the road")
local report = table.concat(last().report, " | ")
_print("report: " .. report)
assert(report:match("8 / 9") and report:match("1 en pont") and report:match("3 en tunnel") and report:match("1 refusé")
       and report:match("Voie ferrée : 1 croisement%(s%) de route passé%(s%) dessous en tunnel")
       and report:match("Trop pentu") and report:match("coupures vers 3000, 100"), "rail report")
assert(SIM.window.name == "RealmapWindow", "still one window")
-- Lyon: the real shares (900 × 0.4 / 0.35 / 0.25), then its goods; the others: the game's split, no goods.
local caps, needs = {}, {}
for _, c in ipairs(SIM.cmds) do
  if c.kind == "makeTownSetInitialLandUseCapacitiesCmd" then caps[#caps + 1] = table.concat(c.args[2], "/") end
  if c.kind == "makeTownUpdateCargoNeedsCmd" then needs[#needs + 1] = c end
end
assert(caps[1] == "360/315/225" or caps[2] == "360/315/225" or caps[3] == "360/315/225", "real shares: " .. table.concat(caps, " "))
assert(#needs == 1, "only Lyon gets goods")
local a = needs[1].args[2]
assert(#a[1] == 1 and a[1][1] == 5 and #a[2] == 1 and a[2][1] == 22 and #a[3] == 1 and a[3][1] == 21 and needs[1].args[3] == true,
       "cargo needs: residential kept, vegetables / planks, unknown skipped")
assert(last().message:match("générée"), "done message")

-- 4. Same request: not run again; the mod says so in the log and in alive.lua.
local n = #SIM.cmds
SIM.play(pumpStep)
assert(#SIM.cmds == n, "a request runs once")
local alive = SIM.saves["realmap_alive"]
assert(alive and alive.version and alive.userdata == "C:/Steam/userdata/1/3493540/local/" and alive.editor == true
       and alive.seen == SIM.request.id and alive.decision == "answered" and alive.pump == "button", "alive.lua")
assert(SIM.logged("^%[importcity%] mod .* loaded, userdata C:/Steam"), "load line")
assert(SIM.logged("button pump installed") and SIM.logged("pump ticking %(button%)"), "pump lines")
assert(SIM.logged("request %d+ Test: accepted") and SIM.logged("request %d+ Test: answered"), "decision lines")
assert(not SIM.logged("not read") and not SIM.logged("not saved"), "every shared file in a folder the game allows")

-- 5. The mod starts (game launched) with an unanswered request left: no clock, it is left alone;
--    the next one runs. A request cancelled by the app is never run.
local function freshMod()
  SIM.window = nil
  local h = ug_require("importcity::/gui/main_gui.handlers.lua")
  local fn
  h.buttonIcon({ onStep = function(f) fn = f end })
  return h, fn
end
SIM.editor = false
SIM.request = { id = 1, name = "Test", createdAt = 42 }
local h2, step2 = freshMod()
SIM.play(step2)
assert(#SIM.cmds == n and last().id ~= 1 and SIM.saves["realmap_alive"].decision == "baseline", "request found at start left alone")
SIM.request = { id = 2, name = "Test", createdAt = 42 }
SIM.play(step2)
assert(last().id == 2 and last().stage == "error", "next request run")
SIM.request = { id = 3, name = "Test", createdAt = 42, cancelled = true }
SIM.play(step2)
assert(last().id == 2 and SIM.saves["realmap_alive"].decision == "cancelled", "cancelled request ignored")

-- 6. No step from the button (a game update): logged, and the open window runs the pump instead.
SIM.logs = {}
local h3 = ug_require("importcity::/gui/main_gui.handlers.lua")
h3.buttonIcon({})
assert(SIM.logged("pump NOT installed: react.onStep unavailable"), "missing pump logged")
h3.openWindow()
SIM.request = { id = 4, name = "Test", createdAt = 42 }
for _ = 1, 80 do SIM.render() end
assert(SIM.logged("pump ticking %(window%)"), "window pump")
-- First look = baseline (id 4); the next request is run from the window's steps alone.
SIM.request = { id = 5, name = "Test", createdAt = 42 }
for _ = 1, 80 do SIM.render() end
assert(last().id == 5 and SIM.saves["realmap_alive"].pump == "window", "request run by the window pump")

-- 7. status.lua cannot be written: said in the log instead of silence.
SIM.failSave = "realmap_status"
SIM.request = { id = 6, name = "Test", createdAt = 42 }
for _ = 1, 80 do SIM.render() end
SIM.failSave = nil
assert(SIM.logged("realmap_status%.lua not saved: .*disk full"), "save failure logged")
SIM.editor = true

-- 8. A game in German, Chinese, or an unknown language: the generated tables, else English.
for lang, want in pairs({ de_DE = "wurde erstellt", zh_CN = "已生成", pt_BR = "generated" }) do
  SIM.lang = lang
  local m = assert(load(file("gui/importcity_i18n.lua"), "i18n"))()
  local text = m.t("done", "Test")
  assert(text:find(want, 1, true) and text:find("Test", 1, true), lang .. ": " .. text)
end
return true
''')
    print("OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
