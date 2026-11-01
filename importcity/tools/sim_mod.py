#!/usr/bin/env python3
"""Offline simulation of the importcity mod (lupa) against a stubbed TF3 API.

Plays the automatic generation (DECISION-012): the app's request.lua is picked up by the pump, the
mod checks the open map, then builds heightmap > biomes > towns > industries > roads > rail,
writing status.lua at each stage; the game answers commands later (a queue) and the progress
window is rendered so its MapPreviewComp computes the imported map (onReady), as in the game.
Checks: an explicit error outside the Map Editor and for a map of the wrong size, the stage and
command order, import settings (heightmap min/max, biome files, generator), towns created then
sized, industries named, 0-based town pairs, a refused railway piece retried then skipped with the
game's reason, a request run once, an old request ignored.

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


def main() -> int:
    check_generated_script()
    rt = L.LuaRuntime()
    rt.globals().MODDIR = str(MOD).replace("\\", "/")
    ok = rt.execute(r'''
SIM = { queue = {}, cmds = {}, saves = {}, names = {}, nodes = {}, nextEntity = 5000, stages = {},
        editor = true, tiles = { 32, 32 }, gameTowns = {}, constructions = {} }
local _print = print
print = function() end
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
    SegmentAndEntity = { new = function() return { comp = {} } end },
    ComponentType = { TOWN = "TOWN", CONSTRUCTION = "CONSTRUCTION", BASE_NODE = "BASE_NODE" },
    enum = { BaseEdgeType = { NORMAL = "NORMAL", BRIDGE = "BRIDGE", TUNNEL = "TUNNEL" }, RoadType = { TRACK = "TRACK" } },
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
      getWorld = function() return 1 end,
      getYear = function() return 1925 end,
      proposal = {
        createIndustryProposal = function(_, info) return { industry = info } end,
        -- The game's diagnosis of a track proposal (reported only when it is refused).
        makeProposalData = function() return { errorState = { messages = { "Trop pentu" }, critical = true } } end,
      },
    },
    getComponent = function(e, ct)
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
app = {
  res = { terrainGeneratorRep = {
    getAll = function() return { [1] = true, [2] = true } end,
    get = function(k)
      if k == 1 then return { climate = "temperate.clima", isImportGenerator = false, order = 1, params = {} } end
      return { climate = "temperate.clima", isImportGenerator = true, order = 2, params = { { key = "water", numbers = {}, defaultIndex = 3 } } }
    end,
    getName = function(k) return k == 2 and "temperate_import.gen" or "temperate.gen" end,
  } },
  getAllHeightmaps = function() return { "Other", "Test" } end,
  getAllBiomes = function() return { "Test_biomes", "Test_mountains", "Test_rivers" } end,
  loadUserdata = function(dir, name)
    if dir == "towns_industries" and name == "Test" then return TOWNS_FILE end
    if dir ~= "importcity" then return nil end
    if name == "latest" then return { name = "Test" } end
    if name == "Test" then return NOTE end
    if name == "request" then return SIM.request end
    return SIM.saves[dir .. "/" .. name]
  end,
  saveUserdata = function(dir, name, tbl)
    SIM.saves[dir .. "/" .. name] = tbl
    if name == "status" then SIM.stages[#SIM.stages + 1] = tbl.stage end
  end,
}

local function answer(c)
  if c.kind == "makeWorldReplaceTerrainCmd" then SIM.replaced = (SIM.replaced or {}); SIM.replaced[#SIM.replaced + 1] = c.args[1].computed; return true, {} end
  if c.kind == "makeTownCreateCmd" then
    for i = #c.args[1], 1, -1 do
      local t = c.args[1][i]
      SIM.gameTowns[#SIM.gameTowns + 1] = { existing = 100 + #SIM.gameTowns + 1, name = t.name, pos = t.pos }
    end
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
      -- The app's design laid as is: its heights, its tangents scaled to the edge length.
      local len = math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2 + (b.z - a.z) ^ 2)
      if a.z ~= 30 or math.abs(c.tangent0.x - len) > 1e-6 or math.abs(c.tangent1.x - len) > 1e-6 then
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
local function last() return SIM.saves["importcity/status"] end

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
SIM.stages = {}
SIM.request = { id = now() * 1000 + 2, name = "Test", createdAt = 42 }
SIM.play(pumpStep)
local seq = table.concat(SIM.stages, " ")
_print("stages: " .. seq)
assert(seq == "check heightmap biomes rail towns industries roads done", "stage order: " .. seq)
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
  elseif c.kind == "makeWorldBuildProposalCmd" then order[#order + 1] = "rail" end
end
local cmdSeq = table.concat(order, " ")
_print("commands: " .. cmdSeq)
assert(cmdSeq:match("^terrain terrain rail[ rail]* towns size size size industry industry roads$"), "command order: " .. cmdSeq)
local conn
for _, c in ipairs(SIM.cmds) do if c.kind == "makeTownConnectWithIndustriesCmd" then conn = c end end
-- Game order: Givors (101), Bron (102), Lyon (103). Lyon–Bron = {2, 1}, Lyon–Givors = {2, 0}.
assert(conn.args[2][1][1] == 2 and conn.args[2][1][2] == 1 and conn.args[2][2][1] == 2 and conn.args[2][2][2] == 0, "0-based town pairs")
assert(conn.args[3] == false, "fresh roads")
table.sort(SIM.names)
assert(table.concat(SIM.names, "|") == "Carrière de Bron|Ferme de Lyon", "names")
assert(not SIM.malformed, "every track segment is filled like the game's")
assert(SIM.segments == 7 and SIM.bridges == 1 and SIM.tunnels == 1, "7 of 8 railway edges, the river one a bridge, one tunnel")
local report = table.concat(last().report, " | ")
_print("report: " .. report)
assert(report:match("7 / 8") and report:match("1 en pont") and report:match("1 en tunnel") and report:match("1 refusé")
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

-- 4. Same request: not run again. 5. An old request: ignored.
local n = #SIM.cmds
SIM.play(pumpStep)
assert(#SIM.cmds == n, "a request runs once")
SIM.request = { id = (now() - 3600) * 1000, name = "Test", createdAt = 42 }
SIM.play(pumpStep)
assert(#SIM.cmds == n and last().id ~= SIM.request.id, "old request ignored")
-- 4. A game in German, Chinese, or an unknown language: the generated tables, else English.
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
