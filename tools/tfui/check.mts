// Validate a .tfui.json against the TFUI editor schema (what "Ouvrir" checks). Run from ../TFUI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [projectPath, tfuiRepo = process.cwd()] = process.argv.slice(2);
const { tfuiProjectSchema } = await import(pathToFileURL(join(tfuiRepo, "src/model/schema.ts")).href);
const r = tfuiProjectSchema.safeParse(JSON.parse(readFileSync(projectPath, "utf8")));
console.log(r.success ? "schema OK" : JSON.stringify(r.error.issues, null, 1));
process.exit(r.success ? 0 : 1);
