function parseInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return { target: "", action: "create", payload: { text } };
    }
  }
  return { target: "", action: "create", payload: { text } };
}

function normalizeAction(action) {
  const a = String(action || "").toLowerCase();
  if (!a) return "create";
  if (a === "add" || a === "new") return "create";
  if (a === "append" || a === "add-text") return "append";
  if (a === "search" || a === "find") return "search";
  if (a === "list" || a === "ls") return "list";
  if (a === "update" || a === "edit") return "update";
  if (a === "delete" || a === "remove") return "delete";
  return a;
}

function buildAdvice(target) {
  const t = target || "notes";
  return [
    `请选择 notes 目标：apple-notes / bear-notes / notion / obsidian`,
    `用法示例：{"target":"${t}","action":"create","payload":{"title":"...","body":"..."}}`
  ].join("\n");
}

export async function run(input) {
  const payload = parseInput(input);
  const target = String(payload.target || "").trim();
  const action = normalizeAction(payload.action);
  if (!target) return buildAdvice("");
  const out = {
    target,
    action,
    payload: payload.payload || {}
  };
  return JSON.stringify(out, null, 2);
}
