/** 迁移自 tests/js/skills.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import fs from "node:fs";
import path from "node:path";
import { listSkills, runSkill } from "../../src/js/skills/registry.js";

describe('skills', () => {
  it("should listSkills discovers manifests", () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "sessions", "skills-"));
    const skillDir = path.join(dir, "echo");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: echo",
        "description: Echo input text",
        "---",
        "",
        "# Echo",
        "Return the input verbatim."
      ].join("\n")
    );

    const skills = listSkills(dir);
    expect(skills.length).toBe(1);
    expect(skills[0].manifest.name).toBe("echo");
  });

  it("should runSkill executes executable skill.json when present", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "sessions", "skills-exec-"));
    const skillDir = path.join(dir, "skills", "x-echo");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: x-echo", "description: executable echo", "---", "", "placeholder"].join("\n")
    );
    fs.writeFileSync(
      path.join(skillDir, "skill.json"),
      JSON.stringify({ name: "x-echo", entry: "index.js" }, null, 2)
    );
    fs.writeFileSync(
      path.join(skillDir, "index.js"),
      ["export async function run(input) {", "  return String(input);", "}"].join("\n")
    );

    // Run via direct import path by temporarily chdir into the temp skill root.
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const out = await runSkill("x-echo", "hello");
      expect(out).toBe("hello");
    } finally {
      process.chdir(prev);
    }
  });

  it("should runSkill executes index.js implementation even without skill.json", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "sessions", "skills-index-"));
    const skillDir = path.join(dir, "skills", "x-index");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: x-index", "description: executable by convention", "---", "", "placeholder"].join("\n")
    );
    fs.writeFileSync(path.join(skillDir, "index.js"), ["export async function run() {", "  return 'ok';", "}"].join("\n"));

    const prev = process.cwd();
    process.chdir(dir);
    try {
      const out = await runSkill("x-index", "");
      expect(out).toBe("ok");
    } finally {
      process.chdir(prev);
    }
  });
});
