import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKILLS_DIR = path.join(ROOT, "skills");

const BODY_BY_SKILL = {
  "api-integration": `# API Integration

## Purpose
Call a single HTTP endpoint and return a concise response summary.

## Input
Accept plain text or JSON. If plain text, treat it as \`url\`.

JSON fields:
- \`method\`: HTTP method (default: GET)
- \`url\` or \`endpoint\`: target URL (required)
- \`headers\`: object of headers
- \`auth\`: value for \`Authorization\` header
- \`body\`: object to JSON-encode
- \`rawBody\`: raw body string (used if \`body\` is not provided)
- \`timeoutMs\`: request timeout in milliseconds (default: 8000)

## Output
Return JSON:
- \`ok\`, \`status\`, \`headers\`, \`body\` (truncate body to ~5000 chars)

## Guidance
- If the request fails, return \`request_failed: <error>\`.
- Keep output JSON pretty-printed.`,
  "auto-skill-excel-csv": `# Auto Skill for Excel/CSV

## Purpose
Collect requirements and draft a reusable skill plan for Excel/CSV automation.

## Input
Plain text describing the desired automation, data source, and expected output.

## Output
Return a concise plan:
- task summary
- required inputs (files/columns)
- expected output format
- any missing details to confirm

## Guidance
- Ask for missing file paths or column names.
- Keep it short and actionable.`,
  "data-analysis": `# Data Analysis (CSV/TSV/JSON)

## Purpose
Summarize tabular data or clean it and write a cleaned CSV.

## Input
Accept JSON or plain text.

JSON fields:
- \`path\`: local file path (csv/tsv/json)
- \`format\`: csv | tsv | json (optional, inferred from extension)
- \`header\`: boolean, whether first row is headers (default: true)
- \`action\`: summary | clean (default: summary)
- \`delimiter\`: override delimiter for csv
- \`rows\`, \`headers\`: direct data input (optional)
- \`dedupe\`: boolean (default: true)
- \`dropEmpty\`: boolean (default: true)
- \`outputPath\`: where to write cleaned csv (default: sessions/cleaned.csv)

## Output
If action=clean: JSON { written, rows }.
If action=summary: JSON { rows, columns, headers, stats } with numeric min/max/avg and empty counts.

## Guidance
- Use read_file to load data and write_file to save output.
- Validate that path exists when provided.`,
  "doc-generation": `# Document Generation

## Purpose
Generate a Markdown report or slide outline and optionally write to file.

## Input
JSON fields:
- \`title\`
- \`summary\`
- \`sections\`: [{ title, content, bullets[] }]
- \`appendix\`
- \`mode\` or \`action\`: report | slides (default: report)
- \`outputPath\`: if set, write markdown to this path

## Output
Markdown string, or \`written: <path>\` if outputPath is set.

## Guidance
- Keep headings as H1/H2.
- For slides mode, treat sections as slide blocks.`,
  "echo": `# Echo

## Purpose
Return the input verbatim.

## Input
Plain text.

## Output
Echoed text in the form: \`echo: <input>\`.`,
  "email-automation": `# Email Automation

## Purpose
Draft, queue, categorize, or send emails via SMTP; create reminders.

## Input
JSON fields:
- \`action\`: draft | send | categorize | remind (default: draft)
- \`to\`, \`cc\`, \`bcc\` (string or array)
- \`subject\`, \`body\`
- \`items\`: list for categorize [{ subject, body }]
- \`dueAt\` or \`at\`: reminder time

SMTP env:
- \`SMTP_HOST\`, \`SMTP_PORT\`, \`SMTP_USER\`, \`SMTP_PASS\`
- \`SMTP_FROM\`, \`SMTP_SECURE\`, \`SMTP_STARTTLS\`

## Output
- draft: \`draft: <sessions/outbox/*.json>\`
- send: JSON { sent: true, ... } or \`send_failed_queued: <file>\`
- categorize: JSON { categorized: [...] }
- remind: \`reminder_saved: <sessions/reminders/reminders.json>\`

## Guidance
- If SMTP send fails, queue into sessions/outbox with status queued.`,
  "entity-intro": `# Entity Intro

## Purpose
Generate a generalized introduction for a person/company using local memory and optional web snippet.

## Input
JSON fields:
- \`person\` or \`name\`
- \`company\` or \`org\`
- \`query\`
- \`includeMemory\` (default: true)
- \`web.url\` (optional)

## Output
Markdown with:
- title
- bullet points from local memory
- optional web snippet
- request for more context if insufficient data

## Guidance
- Read local memory under sessions/memory/users.
- If web.url provided, fetch and extract a short snippet.`,
  "insight-summary": `# Insight Summary

## Purpose
Extract key points from a long text.

## Input
Plain text or JSON:
- \`text\`
- \`maxPoints\` (default: 5)

## Output
JSON: { points: [ ... ] }`,
  "map-query": `# Map Query

## Purpose
Find places and return basic location details and distance hints.

## Input
JSON fields:
- \`keyword\` (what to search)
- \`location\` (reference address/place)
- \`city\`
- \`maxResults\`

## Output
Markdown list of places with address and approximate distance.

## Guidance
- If a map API key is available, call it. Otherwise, provide a best-effort guess and ask for a key.
- Keep results concise and practical.`,
  "map-share-links": `# Map Share Links

## Purpose
Generate share/search links for map providers.

## Input
JSON fields:
- \`name\`, \`address\`
- \`lat\`, \`lng\` (optional)
- \`providers\`: list like ["amap","baidu","google"]

## Output
Markdown with links for each provider.

## Guidance
- If lat/lng provided, use direct coordinates; otherwise use search URLs.`,
  "moltbook": `# Moltbook

## Purpose
Interact with Moltbook: status, register, post, comment.

## Input
JSON fields:
- \`action\`: help | status | register | post | comment
- register: \`name\`, \`description\`
- post: \`content\`
- comment: \`post_id\`, \`content\`, \`parent_id\` (optional)

Env:
- \`MOLTBOOK_API_BASE\` (default https://www.moltbook.com)
- \`MOLTBOOK_BEARER_TOKEN\` or \`MOLTBOOK_API_KEY\`

## Output
JSON result per action, with \`ok\`, \`status\`, \`data\`.

## Guidance
- If auth missing, return a clear hint about required env vars.`,
  "scheduled-tasks": `# Scheduled Tasks

## Purpose
Create local schedule definitions for automation workflows.

## Input
JSON fields:
- \`name\`
- \`schedule\` or \`rrule\`
- \`action\` or \`command\` or \`skill\`
- \`payload\` (optional)
- \`outputPath\` (default: sessions/schedules/tasks.json)
- \`nextRunAt\` / \`dueAt\` / \`at\`

## Output
\`scheduled: <name> -> <file>\`

## Guidance
- Append entry to the JSON list at outputPath.`,
  "slide-outline": `# Slide Outline

## Purpose
Create a slide outline from a topic or explicit sections.

## Input
JSON fields:
- \`topic\`
- \`goal\`
- \`sections\`: [{ title, bullets[] }]

## Output
Markdown outline with H2 sections and bullets.`,
  "survey-batch": `# Survey Plan

## Purpose
Generate a research plan and interview question list.

## Input
JSON fields:
- \`topic\`
- \`goals\` (optional list)

## Output
Markdown plan with goals, sample size, and question list.`,
  "web-scraper": `# Web Scraper

## Purpose
Fetch and extract content from web pages with optional summarize or diff.

## Input
JSON fields:
- \`url\` or \`urls\`
- \`mode\`: extract | summarize | diff
- \`timeoutMs\`
- \`maxChars\`, \`maxSentences\`
- \`storePath\` (diff mode, default: sessions/web-monitor/index.json)

## Output
JSON with title, snippet, summary, and/or diff status.

## Guidance
- For diff mode, store hash for change detection.`,
  "workflow-runner": `# Workflow Runner

## Purpose
Generate a structured workflow definition from steps.

## Input
JSON fields:
- \`name\`
- \`steps\`: [{ name, action, input }]

## Output
JSON workflow with generated ids, createdAt, and step structure.`
};

function toTitle(name) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildSkillMd(name, description, body) {
  const desc = description || `Skill ${name}`;
  const title = toTitle(name);
  return [
    "---",
    `name: ${name}`,
    `description: ${desc.replace(/\n+/g, " ").trim()}`,
    "---",
    "",
    `# ${title}`,
    "",
    body.trim(),
    ""
  ].join("\n");
}

function main() {
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SKILLS_DIR, entry.name);
    const manifestPath = path.join(dir, "skill.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const body = BODY_BY_SKILL[entry.name];
    if (!body) {
      throw new Error(`Missing SKILL.md body template for ${entry.name}`);
    }
    const skillMd = buildSkillMd(entry.name, manifest.description, body);
    fs.writeFileSync(path.join(dir, "SKILL.md"), skillMd);
    fs.rmSync(path.join(dir, "index.js"), { force: true });
    fs.rmSync(path.join(dir, "skill.json"), { force: true });
    if (entry.name === "map-share-links") {
      fs.rmSync(path.join(dir, "real-links.js"), { force: true });
    }
  }
}

main();
