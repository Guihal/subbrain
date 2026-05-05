import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export default class FixtureProvider {
  async callApi(_prompt, ctx) {
    const rel = ctx?.vars?.fixture_path;
    if (!rel) throw new Error("fixture_path missing in vars");
    const path = resolve(rel);
    const output = await readFile(path, "utf8");
    return { output };
  }
}
