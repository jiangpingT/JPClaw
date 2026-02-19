import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../dist/shared/config.js";
import { resolveProvider } from "../../dist/providers/index.js";

function parseInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  return { requirement: text };
}

function ensureAllowedPath(value) {
  if (!value) return null;
  const full = path.resolve(process.cwd(), value);
  const roots = [path.resolve(process.cwd(), "sessions"), path.resolve(process.cwd(), "assets")];
  const ok = roots.some((r) => full.startsWith(r + path.sep) || full === r);
  if (!ok) throw new Error(`Path not allowed: ${value}`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

function fallbackMermaid(diagramType, title) {
  const t = String(title || "System Design");
  const type = String(diagramType || "flowchart").toLowerCase();
  if (type === "sequence") {
    return `sequenceDiagram\n  participant U as User\n  participant A as App\n  participant S as Service\n  U->>A: Request (${t})\n  A->>S: Validate & Execute\n  S-->>A: Result\n  A-->>U: Response`;
  }
  if (type === "class") {
    return `classDiagram\n  class Client {\n    +request()\n  }\n  class Service {\n    +execute()\n  }\n  class Repository {\n    +read()\n    +write()\n  }\n  Client --> Service\n  Service --> Repository`;
  }
  if (type === "er") {
    return `erDiagram\n  USER ||--o{ TASK : creates\n  TASK ||--o{ COMMENT : has\n  USER {\n    string id\n    string name\n  }\n  TASK {\n    string id\n    string status\n  }\n  COMMENT {\n    string id\n    string body\n  }`;
  }
  if (type === "state") {
    return `stateDiagram-v2\n  [*] --> Draft\n  Draft --> Reviewing\n  Reviewing --> Approved\n  Reviewing --> Rejected\n  Rejected --> Draft\n  Approved --> [*]`;
  }
  return `flowchart TD\n  A[Input: ${t}] --> B[Validate]\n  B --> C[Process]\n  C --> D[Persist]\n  D --> E[Notify]\n  E --> F[Output]`;
}

function buildMarkdown(title, diagramType, mermaid, requirement) {
  return [
    `# ${title}`,
    "",
    "## Context",
    requirement,
    "",
    "## Design Summary",
    `- Diagram type: ${diagramType}`,
    "- Keep modules loosely coupled and interfaces explicit.",
    "",
    "## Mermaid",
    "```mermaid",
    mermaid,
    "```",
    "",
    "## Risks",
    "- Missing edge cases in input validation.",
    "- Coupling growth if boundaries are not enforced."
  ].join("\n");
}

async function generateByModel(requirement, diagramType, title) {
  const provider = resolveProvider(loadConfig());
  if (!provider) return null;
  const system = [
    "You are a software architect.",
    "Return JSON only with keys: mermaid, markdown.",
    "Mermaid must be valid and concise.",
    "Markdown must contain sections: Context, Design Summary, Mermaid, Risks."
  ].join("\n");
  const user = [
    `Title: ${title}`,
    `DiagramType: ${diagramType}`,
    "Requirement:",
    requirement
  ].join("\n");
  const out = await provider.generate([
    { role: "system", content: system },
    { role: "user", content: user }
  ]);
  const text = String(out.text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    const json = JSON.parse(text);
    return {
      mermaid: String(json?.mermaid || "").trim(),
      markdown: String(json?.markdown || "").trim()
    };
  } catch {
    return null;
  }
}

export async function run(input) {
  const payload = parseInput(input);
  const requirement = String(payload.requirement || "").trim();
  if (!requirement) return JSON.stringify({ ok: false, error: "missing_requirement" }, null, 2);
  const diagramType = String(payload.diagramType || "flowchart").toLowerCase();
  const title = String(payload.title || "Design Document").trim();

  let mermaid = "";
  let markdown = "";
  const modelOut = await generateByModel(requirement, diagramType, title).catch(() => null);
  if (modelOut?.mermaid && modelOut?.markdown) {
    mermaid = modelOut.mermaid;
    markdown = modelOut.markdown;
  } else {
    mermaid = fallbackMermaid(diagramType, title);
    markdown = buildMarkdown(title, diagramType, mermaid, requirement);
  }

  let savedPath = null;
  if (payload.outputPath) {
    const full = ensureAllowedPath(String(payload.outputPath));
    fs.writeFileSync(full, markdown, "utf-8");
    savedPath = full;
  }

  return JSON.stringify(
    {
      ok: true,
      title,
      diagramType,
      mermaid,
      markdown,
      savedPath
    },
    null,
    2
  );
}
