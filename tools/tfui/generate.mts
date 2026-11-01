/**
 * Regenerate the mod GUI from importcity/importcity.tfui.json with the TFUI editor's own code generator and
 * component catalog (same output as "Générer" in TFUI). Handlers files are never touched.
 * Run from the TFUI repo (its node_modules resolve the imports):
 *   cd ../TFUI && npx tsx ../RealMap/tools/tfui/generate.mts ../RealMap/importcity/importcity.tfui.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [projectPath, tfuiRepo = process.cwd()] = process.argv.slice(2);
if (!projectPath) {
  console.error("usage: tsx tools/tfui/generate.mts <project.tfui.json> [<TFUI repo>]");
  process.exit(2);
}
const mod = (p: string) => import(pathToFileURL(join(tfuiRepo, p)).href);
const { loadMergedCatalogFromDisk } = await mod("src/catalog/loadMergedCatalog.ts");
const { setActiveCatalog } = await mod("src/catalog/activeCatalog.ts");
const { generateProject } = await mod("src/codegen/generate.ts");

// Without the catalog the generator cannot tell single-child slots (Button.content, Window.content…)
// from lists and emits `content = { … }`, which the game rejects ("Could not assign value to userdata").
const catalog = loadMergedCatalogFromDisk();
if (!catalog) throw new Error(`TFUI catalog not found in ${tfuiRepo}`);
setActiveCatalog(catalog);

const project = JSON.parse(readFileSync(projectPath, "utf8"));
if (project.catalogHash !== catalog.sourceHash) {
  console.warn(`WARN catalogHash ${project.catalogHash} != TFUI catalog ${catalog.sourceHash}`);
}
const outDir = resolve(dirname(projectPath), project.mod.modRoot, "content", project.mod.guiDir);
mkdirSync(outDir, { recursive: true });
for (const file of generateProject(project) as { path: string; content: string }[]) {
  const dest = join(outDir, file.path.split(/[\\/]/).pop()!);
  writeFileSync(dest, file.content, "utf8");
  console.log("OK", dest);
}
