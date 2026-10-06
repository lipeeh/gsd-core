/**
 * GSD plugin for OpenCode.ai  (CommonJS)
 *
 * Architecture: SUBPROCESS REUSE. Instead of re-implementing hook logic inside
 * the plugin, this file is a thin adapter that spawns the existing Claude Code
 * hook scripts under hooks/ as child processes. The hooks speak a stable
 * protocol (JSON on stdin, JSON + exit code on stdout); this adapter:
 *   1. Translates OpenCode plugin events into Claude Code hook payloads
 *   2. Spawns `node <HOOKS_DIR>/<hook>.js` with the payload on stdin
 *   3. Translates hook output back into OpenCode semantics
 *      - block  → throw Error (OpenCode returns the error to the model)
 *      - advisory → output.metadata + console.error (best-effort surfacing)
 *
 * Namespace conversion (/gsd:xxx → /gsd-xxx) reuses scripts/fix-slash-commands.cjs
 * via require(), keeping the single source of truth.
 *
 * ── Two distribution shapes, one adapter (issue #1914) ─────────────────────
 * This single file serves both distribution paths, distinguished at load time
 * by REPO_ROOT (path.resolve(__dirname, "../..")):
 *
 *   • Option 1 — file copy (the supported GSD path). `bin/install.js` copies
 *     this file to <opencodeConfigDir>/plugins/gsd-core.js, so REPO_ROOT is the
 *     OpenCode config dir. GSD's own install already stages `hooks/*.js` and
 *     `gsd-core/` there (ADR-857 skips hook *registration* for OpenCode, not the
 *     file copy), so the hook bridge and content rewriting resolve natively.
 *     Commands/agents/skills are ALREADY registered by GSD's native file copy in
 *     this mode, so the plugin's own config-hook registration is redundant and is
 *     SKIPPED (see IS_PACKAGE_TREE) to avoid double-registration.
 *
 *   • Option 2 — package / git-spec. When loaded from the package tree (npm
 *     `main`, or an OpenCode git-spec install), REPO_ROOT is the package root and
 *     the source layout (commands/gsd/, agents/, skills/) is present. Here the
 *     plugin IS the sole registrar, so it registers commands/agents/skills too.
 *
 * IS_PACKAGE_TREE keys off the presence of the SOURCE command layout
 * (commands/gsd/), which only exists in the package tree — never in an installed
 * config dir (that uses the flattened command/ layout). The hook bridge and
 * Read-time content rewriting run in BOTH modes; only the config-hook
 * registration of commands/agents/skills is gated.
 *
 * Runtime-specific hooks are deliberately excluded:
 *   - gsd-statusline.js / gsd-update-banner.js (Claude Code statusline)
 *   - gsd-cursor-*.js (Cursor-specific)
 *   - *.sh scripts (invoked directly by commands/agents, not hook events)
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

// Resolve REPO_ROOT to the directory that actually holds the GSD payload
// (hooks/ + gsd-core/). This must work across three physical layouts because a
// single adapter file serves both distribution shapes (see header):
//   • package/git-spec tree:  <root>/.opencode/plugins/gsd-core.js   → <root>
//   • global file-copy:       ~/.config/opencode/plugins/gsd-core.js → ~/.config/opencode
//   • local file-copy:        <proj>/.opencode/plugins/gsd-core.js   → <proj>/.opencode
// A fixed "../.." only works for the first; the copied layouts sit one level
// shallower. Walking up to the first ancestor containing BOTH payload markers
// resolves all three deterministically. Falls back to the package-tree
// assumption ("../..") if no ancestor matches (keeps graceful degradation).
function resolveRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (
      fs.existsSync(path.join(dir, "hooks")) &&
      fs.existsSync(path.join(dir, "gsd-core"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  // No ancestor carried both markers (broken/partial layout — the plugin can't
  // function regardless). Fall back to the package-tree assumption ("../.."),
  // matching the historical fixed-depth behavior and the .opencode/plugins/
  // source layout.
  return path.resolve(startDir, "../..");
}

// CJS: __dirname is a global, no need to derive from import.meta.url
const REPO_ROOT = resolveRepoRoot(__dirname);
const HOOKS_DIR = path.join(REPO_ROOT, "hooks");
const COMMANDS = path.join(REPO_ROOT, "commands", "gsd");
const AGENTS = path.join(REPO_ROOT, "agents");
const SKILLS = path.join(REPO_ROOT, "skills");
const GSD_CORE = path.join(REPO_ROOT, "gsd-core");

// True only when loaded from the package/source tree (Option 2), detected by the
// presence of the SOURCE command layout (commands/gsd/). In an installed OpenCode
// config dir (Option 1) this directory is absent — the flattened command/ layout
// is used instead — so the plugin skips its own command/agent/skill registration
// and lets GSD's native file copy own that surface (avoids double-registration).
const IS_PACKAGE_TREE = fs.existsSync(COMMANDS);

// ---------------------------------------------------------------------------
// Namespace conversion — reuse the single source of truth
// ---------------------------------------------------------------------------

let _cmdNames = null;
let _transformFn = null;

/**
 * Lazily load scripts/fix-slash-commands.cjs and cache the transform function
 * + command name list. Returns null if the module is unavailable (the plugin
 * still works, just without namespace conversion).
 */
function getNamespaceConverter() {
  if (_transformFn) return _transformFn;
  try {
    const mod = require(
      path.join(REPO_ROOT, "scripts", "fix-slash-commands.cjs"),
    );
    _cmdNames = mod.readCmdNames();
    _transformFn = mod.transformContentToHyphen;
    return _transformFn;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session state — tracked across plugin hook invocations
// ---------------------------------------------------------------------------

let currentSessionId = null;
let currentCwd = process.cwd();

// ---------------------------------------------------------------------------
// Tool name / argument mapping  (OpenCode ↔ Claude Code)
// ---------------------------------------------------------------------------

const TOOL_NAME_MAP = {
  read: "Read",
  grep: "Grep",
  write: "Write",
  edit: "Edit",
  apply_patch: "MultiEdit",
  multi_edit: "MultiEdit",
  bash: "Bash",
  webfetch: "WebFetch",
  web_search: "WebSearch",
  websearch: "WebSearch",
  task: "Task",
  subagent: "Task",
};

function mapToolName(tool) {
  if (!tool) return "";
  return TOOL_NAME_MAP[String(tool).toLowerCase()] || tool;
}

// Build a Claude-style `tool_input` object from OpenCode's `output.args`.
function mapToolInput(args) {
  const input = {};
  if (!args || typeof args !== "object") return input;

  // File-path keys (OpenCode uses filePath/path; Claude uses file_path)
  const filePath = args.filePath || args.path || args.file_path;
  if (filePath) input.file_path = filePath;

  // Content for Write
  if (args.content !== undefined) input.content = args.content;

  // Edit patch fields
  if (args.new_string !== undefined) input.new_string = args.new_string;
  if (args.newString !== undefined) input.new_string = args.newString;
  if (args.old_string !== undefined) input.old_string = args.old_string;
  if (args.oldString !== undefined) input.old_string = args.oldString;

  // Bash command
  if (args.command !== undefined) input.command = args.command;

  // Grep file filter (OpenCode uses include; Claude uses glob)
  const glob = args.glob ?? args.include;
  if (glob !== undefined) input.glob = glob;

  // Web
  if (args.url !== undefined) input.url = args.url;
  if (args.query !== undefined) input.query = args.query;

  return input;
}

// ---------------------------------------------------------------------------
// Hook subprocess runner
// ---------------------------------------------------------------------------

/**
 * Spawn a Claude Code hook script and pipe a JSON payload to its stdin.
 *
 * Hooks follow the convention:
 *   - stdout: JSON object (decision/advisory) or empty
 *   - exit 0: allow (with optional advisory JSON on stdout)
 *   - exit 2: block (Claude convention; reason in stdout JSON)
 *   - any error: exit 0 silently (hooks swallow their own errors)
 *
 * @param {string} hookFile  filename under hooks/, e.g. "gsd-prompt-guard.js"
 * @param {object} payload   stdin JSON (hook_event_name, tool_name, ...)
 * @param {object} [opts]
 * @param {number} [opts.timeout=8000] spawn timeout in ms
 * @param {string} [opts.cwd]         working directory for the child
 * @returns {{ stdout: string, exitCode: number, timedOut: boolean }}
 */
const warnedMissingHooks = new Set();

// A hook this adapter kills on timeout has no exit status, so runHook below
// reports it as exit 0 — an ALLOW. For a guard that blocks, a bound shorter
// than the guard's own worst case therefore silently disables the gate. The
// two guards that probe git (worktree path, workflow force-add) run up to
// BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES sequential probes of
// BLOCKING_GUARD_PROBE_TIMEOUT_MS each (hooks/lib/git-probe.js, #5180), so
// their bound is that product plus a margin for node start/kill/reap. Read
// from the staged hooks/lib so it can never drift from the guards' own budget;
// the fallback is used only when that lib is missing from a partial install,
// and is sized for the same worst case.
const GIT_PROBING_GUARDS = new Set([
  "gsd-worktree-path-guard.js",
  "gsd-workflow-guard.js",
]);
const GIT_PROBING_GUARD_MARGIN_MS = 5000;
const GIT_PROBING_GUARD_FALLBACK_TIMEOUT_MS = 20000;

function gitProbingGuardTimeoutMs() {
  try {
    const probe = require(path.join(HOOKS_DIR, "lib", "git-probe.js"));
    const worstCaseMs =
      probe.BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES *
      probe.BLOCKING_GUARD_PROBE_TIMEOUT_MS;
    if (Number.isFinite(worstCaseMs) && worstCaseMs > 0) {
      return worstCaseMs + GIT_PROBING_GUARD_MARGIN_MS;
    }
  } catch {
    // hooks/lib/git-probe.js unavailable — use the fallback below.
  }
  return GIT_PROBING_GUARD_FALLBACK_TIMEOUT_MS;
}

function runHook(hookFile, payload, opts = {}) {
  const hookPath = path.join(HOOKS_DIR, hookFile);
  if (!fs.existsSync(hookPath)) {
    // A missing guard script means the guard is silently NOT enforced — the
    // exact failure mode of #2305 (plugin staged, hooks bundle not). Never
    // break the tool call (the adapter's design contract), but never be
    // silent about it either: warn loudly, once per hook file.
    if (!warnedMissingHooks.has(hookFile)) {
      warnedMissingHooks.add(hookFile);
      console.error(
        `[gsd-core] hook script missing: ${hookPath} — ${hookFile} is NOT ` +
          "enforced. The GSD install may be incomplete; reinstall (or run " +
          "/gsd-update) to restage the hooks/ bundle.",
      );
    }
    return { stdout: "", exitCode: 0, timedOut: false };
  }
  const timeout =
    opts.timeout ??
    (GIT_PROBING_GUARDS.has(hookFile) ? gitProbingGuardTimeoutMs() : 8000);
  // Under a Bun-compiled host (OpenCode v2 server) process.execPath is the
  // opencode binary itself — spawning it with a hook path runs the CLI, not
  // the guard, and every guard dies silently. Always use a real node binary.
  const nodeBin = resolveNodeBin();
  if (!nodeBin) {
    if (!_nodeBinWarned) {
      _nodeBinWarned = true;
      console.error(
        "[gsd-core] no node runtime found (checked GSD_NODE_BIN, PATH, fnm, " +
          "homebrew) — GSD guards are NOT enforced until node is available.",
      );
    }
    return { stdout: "", exitCode: 0, timedOut: false };
  }
  let result;
  try {
    result = spawnSync(nodeBin, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout,
      cwd: opts.cwd || currentCwd,
      windowsHide: true,
    });
  } catch {
    // Spawn failure — never break the tool call
    return { stdout: "", exitCode: 0, timedOut: false };
  }

  const stdout = (result.stdout || "").trim();
  const exitCode = result.status == null ? 0 : result.status;
  return { stdout, exitCode, timedOut: result.signal === "SIGTERM" };
}

/**
 * In-process check for whether context-usage warnings are disabled in project
 * config. Mirrors the exact semantics of the same check inside
 * hooks/gsd-context-monitor.js (introduced by #1073): an explicit
 * `config.hooks.context_warnings === false` disables them; a missing or
 * unparseable .planning/config.json keeps them enabled (the default).
 *
 * #2697: hoisting this check in-process lets the adapter SKIP the context-monitor
 * spawn entirely when the user has opted out, instead of paying a full Node boot
 * inside the child only to read the boolean and exit. Missing/unparseable config
 * MUST behave identically to the hook (enabled) so the default path is unchanged.
 *
 * @param {string} cwd  project working directory (the plugin's currentCwd)
 * @returns {boolean} true when context warnings are explicitly disabled
 */
function contextWarningsDisabled(cwd) {
  try {
    const configPath = path.join(cwd, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.hooks?.context_warnings === false;
  } catch {
    // Missing or unparseable config → proceed with defaults (context warnings enabled).
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hook output translation → OpenCode semantics
// ---------------------------------------------------------------------------

/**
 * Parse a hook's stdout and apply its effect to the OpenCode output object.
 *
 * - Block   → throw Error(parsed.reason) so OpenCode aborts the tool call
 * - Advisory→ append to output.metadata._gsdAdvisory[] and log to stderr
 * - Silent  → no-op
 *
 * @param {{ stdout: string, exitCode: number }} hookResult
 * @param {object} [output]  OpenCode mutable output object (optional)
 */
function handleHookResult(hookResult, output) {
  const { stdout, exitCode } = hookResult;
  if (!stdout && exitCode !== 2) return; // silent allow

  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Non-JSON stdout (e.g. a stray log) — treat exit 2 as hard block, else allow
    }
  }

  // Block: explicit decision OR Claude exit-code-2 convention
  const isBlock = exitCode === 2 || (parsed && parsed.decision === "block");
  if (isBlock) {
    const reason =
      (parsed && parsed.reason) || "Blocked by GSD hook (no reason provided).";
    throw new Error(reason);
  }

  // Advisory: inject additionalContext into metadata + log
  const advisory =
    parsed &&
    parsed.hookSpecificOutput &&
    parsed.hookSpecificOutput.additionalContext;
  if (advisory) {
    if (output) {
      output.metadata = output.metadata || {};
      // Accumulate: a single tool call can run several advisory hooks in
      // sequence (prompt guard, read guard, worktree guard, workflow guard).
      // Storing a scalar would let a later advisory clobber an earlier one, so
      // collect them all.
      if (!Array.isArray(output.metadata._gsdAdvisory)) {
        output.metadata._gsdAdvisory = [];
      }
      output.metadata._gsdAdvisory.push(advisory);
    }
    // Best-effort visibility when metadata isn't surfaced to the model
    console.error(advisory);
  }
}

// ---------------------------------------------------------------------------
// Frontmatter helpers (for config registration)
// ---------------------------------------------------------------------------

// A self-contained copy of `locateFrontmatterFence` (src/frontmatter-fence.cts, the
// one frontmatter fence owner). Kept here, not required from the built
// gsd-core/bin/lib/frontmatter-fence.cjs, because this plugin must load in every
// layout it is copied to — including a package/git-spec tree, which may carry no
// built bin/lib. Found while implementing #5105: tests/frontmatter-fence.test.cjs
// ("kept frontmatter fence copies agree with the owner") pins this copy to the owner
// over a fixture corpus and a property test, and
// scripts/lint-frontmatter-fence-drift.cjs allowlists exactly this function.
function locateFrontmatterFence(text) {
  if (typeof text !== "string") {
    throw new TypeError(`locateFrontmatterFence: expected a string, got ${typeof text}`);
  }
  const closingFenceLine = /^---[ \t]*$/;
  const lenientClosingFenceLine = /^-{4,}[ \t]*$/;
  const bom = text.charCodeAt(0) === 0xfeff ? text.slice(0, 1) : "";
  const start = bom.length;
  let eol;
  if (text.startsWith("---\r\n", start)) eol = "\r\n";
  else if (text.startsWith("---\n", start)) eol = "\n";
  else return null;
  const openEnd = start + 3 + eol.length;
  const closedAt = (lineStart, lineEnd) => {
    let bodyEnd = openEnd;
    if (lineStart > openEnd) {
      bodyEnd = lineStart - 1;
      if (bodyEnd > openEnd && text[bodyEnd - 1] === "\r") bodyEnd -= 1;
    }
    return { bom, eol, openEnd, closed: true, closingStart: lineStart, closingFenceEnd: lineEnd, bodyEnd };
  };
  let lenient = null;
  let lineStart = openEnd;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline > lineStart && text[newline - 1] === "\r" ? newline - 1 : newline;
    const line = text.slice(lineStart, lineEnd);
    if (closingFenceLine.test(line)) return closedAt(lineStart, lineEnd);
    if (lenient === null && lenientClosingFenceLine.test(line)) lenient = [lineStart, lineEnd];
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (lenient !== null) return closedAt(lenient[0], lenient[1]);
  return { bom, eol, openEnd, closed: false, closingStart: -1, closingFenceEnd: -1, bodyEnd: text.length };
}

function parseFrontmatter(content) {
  const fence = locateFrontmatterFence(content);
  if (!fence || !fence.closed) return { frontmatter: {}, body: content };
  const fm = {};
  for (const line of content.slice(fence.openEnd, fence.bodyEnd).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) {
      let v = line.slice(i + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      fm[line.slice(0, i).trim()] = v;
    }
  }
  // The body is everything past the closing fence line and its line ending.
  return { frontmatter: fm, body: content.slice(fence.closingFenceEnd).replace(/^\r?\n/, "") };
}

// Rewrite @~/.claude/ includes to point at the repo root.
// Also applies /gsd:xxx → /gsd-xxx namespace conversion via the shared
// transform from scripts/fix-slash-commands.cjs (single source of truth).
function rewriteRefs(content) {
  let out = content.replace(/@~\/\.claude\//g, `@${REPO_ROOT}/`);
  const transform = getNamespaceConverter();
  if (transform && _cmdNames && _cmdNames.length) {
    out = transform(out, _cmdNames);
  }
  return out;
}

function loadDir(dir, keyFn, valFn) {
  const result = {};
  if (!fs.existsSync(dir)) return result;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    result[keyFn(f)] = valFn(body, frontmatter, f);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Runtime content transform — for Read tool results on GSD-managed files
// ---------------------------------------------------------------------------

// Directories whose .md files may contain ~/.claude/ paths and gsd: namespace
// refs. When the model reads these via the Read tool, we transparently rewrite
// both so OpenCode sees correct paths and hyphen-form command names.
const GSD_MANAGED_DIRS = [
  path.join(GSD_CORE, "workflows"),
  path.join(GSD_CORE, "references"),
  path.join(GSD_CORE, "templates"),
  path.join(GSD_CORE, "contexts"),
  COMMANDS,
  AGENTS,
  SKILLS,
];

function isGsdManagedFile(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  return GSD_MANAGED_DIRS.some(
    (dir) => resolved === dir || resolved.startsWith(dir + path.sep),
  );
}

// Rewrite content for OpenCode consumption:
//   1. @-include paths:  @~/.claude/  →  @<REPO_ROOT>/
//   2. plain-text paths: ~/.claude/gsd-core/  →  <GSD_CORE>/
//   3. namespace:        gsd:xxx  →  gsd-xxx  (via fix-slash-commands.cjs)
function rewriteContent(content) {
  let out = content;
  out = out.replace(/@~\/\.claude\//g, `@${REPO_ROOT}/`);
  out = out.replace(/~\/\.claude\/gsd-core\//g, `${GSD_CORE}/`);
  const transform = getNamespaceConverter();
  if (transform && _cmdNames && _cmdNames.length) {
    out = transform(out, _cmdNames);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skills cache — copy SKILL.md files with rewritten @-include paths
// ---------------------------------------------------------------------------
//
// OpenCode's skill loader reads SKILL.md files directly from disk and resolves
// @-includes internally — this bypasses our tool.execute hooks. To make
// @~/.claude/gsd-core/... includes resolve, we copy all SKILL.md files to a
// cache directory with paths rewritten to the actual GSD_CORE location.
//
// Only used in package-tree mode (Option 2). In an installed OpenCode config
// dir (Option 1) skills are already staged + registered by GSD's native file
// copy, so we never register skills from the plugin (see IS_PACKAGE_TREE).

const SKILLS_CACHE = path.join(
  os.homedir(),
  ".cache",
  "opencode",
  "gsd-skills",
);

function prepareSkillsCache() {
  if (!fs.existsSync(SKILLS)) return null;
  fs.mkdirSync(SKILLS_CACHE, { recursive: true });
  for (const dir of fs.readdirSync(SKILLS)) {
    const srcFile = path.join(SKILLS, dir, "SKILL.md");
    if (!fs.existsSync(srcFile)) continue;
    const raw = fs.readFileSync(srcFile, "utf8");
    // Rewrite @-include paths only; namespace conversion is handled at
    // Read-time via tool.execute.after for workflow/reference files.
    const rewritten = raw
      .replace(/@~\/\.claude\/gsd-core\//g, `@${GSD_CORE}/`)
      .replace(/~\/\.claude\/gsd-core\//g, `${GSD_CORE}/`);
    const destDir = path.join(SKILLS_CACHE, dir);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "SKILL.md"), rewritten);
  }
  return SKILLS_CACHE;
}

// ===========================================================================
// Plugin entry
// ===========================================================================

const GsdCorePlugin = async ({ directory } = {}) => {
  if (directory) currentCwd = directory;

  return {
    // ── Config: register commands / agents / skills paths ──────────────
    // Only in package-tree mode (Option 2). In an installed config dir
    // (Option 1) GSD's native file copy already registered these, so the
    // plugin stays out of registration to avoid double-registering.
    config: async (config) => {
      if (!IS_PACKAGE_TREE) return;

      // Commands (commands/gsd/*.md → gsd-<name>)
      config.command = config.command || {};
      const cmds = loadDir(
        COMMANDS,
        (f) => "gsd-" + f.slice(0, -3),
        (body, fm, name) => ({
          template: rewriteRefs(body.trim()),
          description: fm.description || `GSD ${name.slice(0, -3)} command`,
        }),
      );
      for (const [k, v] of Object.entries(cmds)) {
        if (!config.command[k]) config.command[k] = v;
      }

      // Agents (agents/*.md)
      config.agent = config.agent || {};
      const agents = loadDir(
        AGENTS,
        (f) => f.slice(0, -3),
        (body, fm, name) => ({
          prompt: rewriteRefs(body.trim()),
          description: fm.description || `GSD ${name.slice(0, -3)} agent`,
          mode: fm.mode || "subagent",
        }),
      );
      for (const [k, v] of Object.entries(agents)) {
        if (!config.agent[k]) config.agent[k] = v;
      }

      // Skills — copy SKILL.md files to cache with rewritten @-include paths,
      // then register the cache directory. OpenCode's skill loader reads
      // SKILL.md from disk and resolves @-includes internally (bypassing our
      // tool.execute hooks), so we must pre-process the files.
      const skillsCache = prepareSkillsCache();
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      const skillsPath = skillsCache || SKILLS;
      if (!config.skills.paths.includes(skillsPath)) {
        config.skills.paths.push(skillsPath);
      }
    },

    // ── shell.env ───────────────────────────────────────────────────────
    "shell.env": async (_input, output) => {
      output.env = output.env || {};
      output.env.GSD_DIR = GSD_CORE;
    },

    // ── tool.execute.before — PreToolUse hooks ─────────────────────────
    "tool.execute.before": async (input, output) => {
      const claudeTool = mapToolName(input.tool);
      const toolInput = mapToolInput(output.args || {});
      const cwd = currentCwd;

      // 0. Read path rewrite — redirect ~/.claude/gsd-core/ to actual GSD_CORE
      //    so the model can read workflow/reference/template files that SKILL.md
      //    and command templates reference via the canonical Claude path.
      if (claudeTool === "Read" && toolInput.file_path) {
        const original = toolInput.file_path;
        const rewritten = original
          .replace(/^~\/\.claude\/gsd-core\//, GSD_CORE + "/")
          .replace(/(?:.*)\/\.claude\/gsd-core\//, GSD_CORE + "/");
        if (rewritten !== original) {
          const args = output.args || {};
          if (args.filePath) args.filePath = rewritten;
          else if (args.path) args.path = rewritten;
          else if (args.file_path) args.file_path = rewritten;
          else args.filePath = rewritten;
        }
      }

      const basePayload = {
        hook_event_name: "PreToolUse",
        cwd,
      };
      // NOTE: session_id intentionally omitted for PreToolUse hooks.
      // gsd-read-guard.js treats a non-empty session_id as a Claude Code
      // session and skips its advisory. On OpenCode we WANT the advisory.
      const prePayload = (overrides = {}) => ({
        ...basePayload,
        tool_name: claudeTool,
        tool_input: toolInput,
        ...overrides,
      });

      const isWriteLike = ["Write", "Edit", "MultiEdit"].includes(claudeTool);

      // 1. gsd-prompt-guard.js — injection scan on .planning/ writes
      if (claudeTool === "Write" || claudeTool === "Edit") {
        const r = runHook("gsd-prompt-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 2. gsd-read-guard.js — read-before-edit advisory
      if (claudeTool === "Write" || claudeTool === "Edit") {
        const r = runHook("gsd-read-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 3. gsd-worktree-path-guard.js — hard-block edits outside worktree
      if (isWriteLike) {
        const r = runHook("gsd-worktree-path-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 4. gsd-write-guard.js — hard-block catastrophic shrink of curated
      //    .planning/ artifacts (ROADMAP.md, milestones/*-ROADMAP.md, STATE.md)
      if (claudeTool === "Write") {
        const r = runHook("gsd-write-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 5. gsd-workflow-guard.js — workflow advisory + git-force-add block
      //    (covers Write/Edit/MultiEdit AND Bash force-add detection)
      if (isWriteLike || claudeTool === "Bash") {
        const r = runHook("gsd-workflow-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 6. gsd-secret-read-guard.js — hard-block reads of .env / .env.<suffix> /
      //    .secrets via Read (file_path), Grep (path or glob) and Bash (command)
      if (["Read", "Grep", "Bash"].includes(claudeTool)) {
        const r = runHook("gsd-secret-read-guard.js", prePayload());
        handleHookResult(r, output);
      }
    },

    // ── tool.execute.after — PostToolUse hooks ─────────────────────────
    "tool.execute.after": async (input, output) => {
      const claudeTool = mapToolName(input.tool);
      // NOTE: In the `after` hook, `args` lives on `input` (not `output`).
      // The `output` object only has { title, output, metadata }.
      const toolInput = mapToolInput(input.args || {});
      const cwd = currentCwd;

      // GSD content transform — rewrite paths + namespace in Read results
      // BEFORE injection scanning so the scanner sees the final content.
      if (
        claudeTool === "Read" &&
        output.output &&
        isGsdManagedFile(toolInput.file_path)
      ) {
        const content =
          typeof output.output === "string"
            ? output.output
            : String(output.output);
        output.output = rewriteContent(content);
      }

      // gsd-read-injection-scanner.js — scan Read/WebFetch/WebSearch results
      if (
        claudeTool === "Read" ||
        claudeTool === "WebFetch" ||
        claudeTool === "WebSearch"
      ) {
        const payload = {
          hook_event_name: "PostToolUse",
          tool_name: claudeTool,
          tool_input: toolInput,
          tool_response: output.output,
          cwd,
        };
        const r = runHook("gsd-read-injection-scanner.js", payload);
        handleHookResult(r, output);
        return;
      }

      // gsd-context-monitor.js — context usage warnings (Bash/Edit/Write/Task/...)
      // Only meaningful when a session_id is tracked (writes metrics sentinel).
      // #2697: skip the subprocess spawn entirely when context warnings are
      // explicitly disabled in project config — the hook would exit early anyway,
      // so hoisting the check in-process avoids paying a Node boot per tool call.
      // Missing/unparseable config = enabled (default), so the spawn still runs.
      if (currentSessionId && !contextWarningsDisabled(cwd)) {
        const payload = {
          hook_event_name: "PostToolUse",
          tool_name: claudeTool,
          tool_input: toolInput,
          session_id: currentSessionId,
          cwd,
        };
        const r = runHook("gsd-context-monitor.js", payload);
        handleHookResult(r, output);
      }
    },

    // ── experimental.session.compacting — PreCompact ───────────────────
    "experimental.session.compacting": async (_input, output) => {
      if (!currentSessionId) return;
      const payload = {
        hook_event_name: "PreCompact",
        session_id: currentSessionId,
        cwd: currentCwd,
      };
      const r = runHook("gsd-context-monitor.js", payload);
      handleHookResult(r, output);

      // Also inject a GSD compaction breadcrumb (mirrors the original plugin)
      output.context = output.context || [];
      output.context.push(
        `[GSD] Active session: ${currentSessionId}. Preserve any in-flight phase/plan state.`,
      );
    },

    // ── General event subscriptions ─────────────────────────────────────
    event: async ({ event }) => {
      // session.created → SessionStart hooks
      if (event.type === "session.created") {
        // Track session for context-monitor payloads.
        // SDK type EventSessionCreated: { properties: { info: Session } }
        // Session has `id` and `directory` (not `cwd`).
        const info = event.properties?.info;
        currentSessionId =
          info?.id || event.sessionID || event.session_id || null;
        if (info?.directory) currentCwd = info.directory;

        // gsd-ensure-canonical-path.js — no stdin dependency; silent
        runHook("gsd-ensure-canonical-path.js", {
          hook_event_name: "SessionStart",
          session_id: currentSessionId,
          cwd: currentCwd,
        });
        // gsd-check-update.js — spawns its own background worker; no stdin
        runHook("gsd-check-update.js", {
          hook_event_name: "SessionStart",
          session_id: currentSessionId,
          cwd: currentCwd,
        });
        return;
      }

      // file.edited → FileChanged hook (config.json reload)
      if (event.type === "file.edited") {
        // SDK type EventFileEdited: { properties: { file: string } }
        const filePath = event.properties?.file || event.filePath || "";
        if (!filePath.endsWith("config.json")) return;
        const cwd = event.properties?.cwd || currentCwd;
        const expected = path.join(cwd, ".planning", "config.json");
        if (path.resolve(filePath) !== path.resolve(expected)) return;

        const payload = {
          hook_event_name: "FileChanged",
          file_path: filePath,
          event: "change",
          cwd,
        };
        const r = runHook("gsd-config-reload.js", payload);
        // Advisory-only (additionalContext); surface to logs
        handleHookResult(r);
        return;
      }

      // session.idle ↔ Claude Stop lifecycle point (#1682 Slice 1b/c).
      // OpenCode fires session.idle when the run quiesces. GSD maps it to the
      // Stop equivalent — the opencode-subset lifecycle peer of compaction
      // (compaction preserves state across context-window summarization; idle
      // marks end-of-turn). No-op sentinel today (GSD state is already
      // persisted to .planning/), but it MUST be recognized so the declared
      // opencode-subset surface is fully wired and a future Stop-class hook can
      // attach without a plugin change.
      if (event.type === "session.idle") {
        return;
      }

      // permission.asked / permission.replied — OpenCode permission lifecycle
      // (#2087, opencode.ai/docs/plugins). GSD gates tool INPUTS at
      // tool.execute.before (read-guard, injection-scanner); the permission
      // grant/deny decision itself carries no GSD workflow-phase contribution,
      // so these are recognized sentinels — wired so a future permission-aware
      // gate can attach without a plugin change (the engine owns phase
      // sequencing; this host bus is session/tool/permission-scoped, never
      // phase-scoped — ADR-1239 §OpenCode).
      if (event.type === "permission.asked" || event.type === "permission.replied") {
        return;
      }

      // session.error — OpenCode session-error lifecycle point (#2087). No GSD
      // hook fires here today (loop state is already persisted to .planning/);
      // recognized so the declared extension-event surface is fully wired and a
      // future error-class hook can attach without a plugin change.
      if (event.type === "session.error") {
        return;
      }
    },
  };
};

// ===========================================================================
// OpenCode v2 setup — native ctx.*.hook registration
// ===========================================================================
//
// Why a separate setup: the v2 loader (2.x) schema-decodes the default export
// as `{ id, setup | effect }` and setup must return a cleanup function (or
// void) — a v1 hooks object returned here would be silently ignored. So v2
// registers the same guard lattice through the context domains instead:
//   shell "create.before"  ← v1 "shell.env" (GSD_DIR)
//   tool "execute.before"  ← v1 "tool.execute.before" (throw = block)
//   tool "execute.after"   ← v1 "tool.execute.after" (result rewrite + scan)
//   session "compaction"    ← v1 "experimental.session.compacting"
//   permission "evaluate"  ← deny-backstop for external-directory writes
//   event.subscribe        ← v1 "event" (session.created tracking; the v2 bus
//                            is server-global with payloads under event.data,
//                            and has no file.edited — the config reload is
//                            bridged with fs.watch instead)
// The v1 `server` entry below is untouched for old hosts. In file-copy installs
// (IS_PACKAGE_TREE false) there is no command/agent/skill registration to port
// — GSD's native file copy already owns that surface.

let _nodeBin; // undefined = unresolved; string = binary; null = none found
let _nodeBinWarned = false;

function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Under a Bun-compiled host (OpenCode v2 server) process.execPath is the
// opencode binary itself — spawning it with a hook path runs the CLI, not the
// guard, and every guard dies silently. Resolve a real node first;
// GSD_NODE_BIN wins when set.
//
// Deliberately probe-free (no `--version` spawn): the resolver must stay a
// pure filesystem lookup so stubbed-spawn test harnesses keep working.
function resolveNodeBin() {
  if (_nodeBin !== undefined) return _nodeBin;
  // Explicit override wins without probing (operator-configured).
  if (process.env.GSD_NODE_BIN) {
    _nodeBin = process.env.GSD_NODE_BIN;
    return _nodeBin;
  }
  const execBase = path.basename(process.execPath || "");
  if (/^node(\.exe)?$/i.test(execBase)) {
    _nodeBin = process.execPath;
    return _nodeBin;
  }
  const candidates = [];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "node"));
  }
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
  try {
    const store = path.join(os.homedir(), ".local", "share", "fnm", "node-versions");
    if (fs.existsSync(store)) {
      for (const v of fs.readdirSync(store).sort().reverse()) {
        candidates.push(path.join(store, v, "installation", "bin", "node"));
      }
    }
  } catch {
    // fnm store unreadable — the PATH candidates cover the common case.
  }
  const seen = new Set();
  for (const bin of candidates) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    if (isExecutableFile(bin)) {
      _nodeBin = bin;
      return bin;
    }
  }
  _nodeBin = null;
  return null;
}

// v2 renamed a few tools (shell, glob, patch); everything matches
// case-insensitively on top of the v1 map.
const V2_TOOL_NAME_EXTRA = {
  shell: "Bash",
  glob: "Grep",
  patch: "MultiEdit",
};

function mapToolNameV2(tool) {
  if (!tool) return "";
  const key = String(tool).toLowerCase();
  return V2_TOOL_NAME_EXTRA[key] || mapToolName(tool);
}

// The v2 execute hook hands over the tool's decoded input object. Key names
// differ per tool/version, so extract tolerantly; the hook subprocesses only
// ever read file_path/path/glob/command (+content on Write/Edit payloads).
function extractV2ToolInput(input) {
  const raw = input && typeof input === "object" ? input : {};
  const toolInput = mapToolInput(raw);
  if (toolInput.file_path == null) {
    const cand = raw.file ?? raw.filename ?? raw.uri;
    if (typeof cand === "string" && cand) {
      toolInput.file_path = cand.replace(/^file:\/\//, "");
    }
  }
  if (toolInput.command === undefined) {
    const cand = raw.cmd ?? raw.script;
    if (typeof cand === "string") toolInput.command = cand;
  }
  if (toolInput.glob === undefined && typeof raw.pattern === "string") {
    toolInput.glob = raw.pattern;
  }
  if (toolInput.file_path != null && toolInput.path === undefined) {
    toolInput.path = toolInput.file_path;
  } else if (toolInput.path != null && toolInput.file_path == null) {
    toolInput.file_path = toolInput.path;
  }
  return { raw, toolInput };
}

// File targets for path-based guards: the single file_path plus multi-file
// patch inputs (files[] as strings or {path} objects).
function v2FileTargets(toolInput, raw) {
  const targets = [];
  if (typeof toolInput.file_path === "string" && toolInput.file_path) {
    targets.push(toolInput.file_path);
  }
  for (const list of [raw.files, raw.file_paths, raw.paths]) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      const p = typeof f === "string" ? f : f && (f.path ?? f.file_path);
      if (typeof p === "string" && p && !targets.includes(p)) targets.push(p);
    }
  }
  return targets;
}

function rewriteReadPathV2(p) {
  return String(p)
    .replace(/^~\/\.claude\/gsd-core\//, GSD_CORE + "/")
    .replace(/(?:.*)\/\.claude\/gsd-core\//, GSD_CORE + "/");
}

async function v2ExecuteBefore(event) {
  const claudeTool = mapToolNameV2(event.tool);
  const { raw, toolInput } = extractV2ToolInput(event.input);
  const cwd = currentCwd;

  // Read path rewrite — mutate the live input (it is mutable in v2) so the
  // tool itself reads the resolved file.
  if (claudeTool === "Read" && toolInput.file_path) {
    const rewritten = rewriteReadPathV2(toolInput.file_path);
    if (rewritten !== toolInput.file_path && raw && typeof raw === "object") {
      for (const k of ["filePath", "path", "file_path", "file"]) {
        if (typeof raw[k] === "string") raw[k] = rewritten;
      }
      toolInput.file_path = rewritten;
      toolInput.path = rewritten;
    }
  }

  const targets = v2FileTargets(toolInput, raw);
  const first = targets[0];
  const scoped = first ? { ...toolInput, file_path: first, path: first } : toolInput;
  const prePayload = (overrides = {}) => ({
    hook_event_name: "PreToolUse",
    tool_name: claudeTool,
    tool_input: scoped,
    cwd,
    ...overrides,
  });
  const isWriteLike = ["Write", "Edit", "MultiEdit"].includes(claudeTool);

  // NOTE: session_id intentionally omitted (gsd-read-guard.js treats a
  // non-empty session_id as a Claude Code session and skips its advisory).
  // No metadata slot exists on v2 execute.before — advisories surface via
  // console.error only; a throw is honored as a block.
  if (claudeTool === "Write" || claudeTool === "Edit") {
    handleHookResult(runHook("gsd-prompt-guard.js", prePayload()));
    handleHookResult(runHook("gsd-read-guard.js", prePayload()));
  }

  if (isWriteLike) {
    for (const t of targets.length ? targets : [undefined]) {
      handleHookResult(
        runHook(
          "gsd-worktree-path-guard.js",
          t ? prePayload({ tool_input: { ...toolInput, file_path: t, path: t } }) : prePayload(),
        ),
      );
    }
  }

  if (claudeTool === "Write") {
    handleHookResult(runHook("gsd-write-guard.js", prePayload()));
  }

  if (isWriteLike || claudeTool === "Bash") {
    handleHookResult(runHook("gsd-workflow-guard.js", prePayload()));
  }

  if (["Read", "Grep", "Bash"].includes(claudeTool)) {
    handleHookResult(runHook("gsd-secret-read-guard.js", prePayload()));
  }
}

// Text slots in a v2 Tool.Result ({ output?, content?: string | Content[] }).
function collectResultTextSlots(result) {
  const slots = [];
  if (!result || typeof result !== "object") return slots;
  if (typeof result.output === "string") {
    slots.push({ get: () => result.output, set: (v) => { result.output = v; } });
  } else if (result.output && typeof result.output === "object" && typeof result.output.content === "string") {
    slots.push({ get: () => result.output.content, set: (v) => { result.output.content = v; } });
  }
  if (typeof result.content === "string") {
    slots.push({ get: () => result.content, set: (v) => { result.content = v; } });
  } else if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        slots.push({ get: () => part.text, set: (v) => { part.text = v; } });
      }
    }
  }
  return slots;
}

async function v2ExecuteAfter(event) {
  const claudeTool = mapToolNameV2(event.tool);
  const { toolInput } = extractV2ToolInput(event.input);
  const cwd = currentCwd;

  if (event.status !== "error") {
    const slots = collectResultTextSlots(event.result);
    const text = slots.map((s) => s.get()).join("\n");

    if (claudeTool === "Read" && toolInput.file_path && isGsdManagedFile(toolInput.file_path) && text) {
      for (const s of slots) s.set(rewriteContent(s.get()));
    }

    if (claudeTool === "Read" || claudeTool === "WebFetch" || claudeTool === "WebSearch") {
      const response = text || (event.result && event.result.output != null ? JSON.stringify(event.result.output) : "");
      if (response) {
        handleHookResult(
          runHook("gsd-read-injection-scanner.js", {
            hook_event_name: "PostToolUse",
            tool_name: claudeTool,
            tool_input: toolInput,
            tool_response: response,
            cwd,
          }),
        );
      }
      return;
    }
  }

  if (currentSessionId && !contextWarningsDisabled(cwd)) {
    handleHookResult(
      runHook("gsd-context-monitor.js", {
        hook_event_name: "PostToolUse",
        tool_name: claudeTool,
        tool_input: toolInput,
        session_id: currentSessionId,
        cwd,
      }),
    );
  }
}

async function v2Compaction(e) {
  if (!currentSessionId) return;
  handleHookResult(
    runHook("gsd-context-monitor.js", {
      hook_event_name: "PreCompact",
      session_id: currentSessionId,
      cwd: currentCwd,
    }),
  );
  try {
    (e.system = e.system || []).push({
      type: "text",
      text: `[GSD] Active session: ${currentSessionId}. Preserve any in-flight phase/plan state.`,
    });
  } catch (err) {
    console.error(`[gsd-core] compaction breadcrumb push failed: ${err && err.message}`);
  }
}

async function v2ShellEnv(e) {
  e.env = e.env || {};
  e.env.GSD_DIR = GSD_CORE;
}

function isInsideDir(root, p) {
  try {
    const rel = path.relative(root, path.resolve(root, p));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

async function v2PermissionEvaluate(e) {
  // Backstop for writes outside the worktree issued through paths that skip
  // the tool hooks (e.g. nested Code Mode calls). Write-like only: reads and
  // shell invocations fail open (v1 parity — the v1 lattice never gated those
  // by path), so legitimate out-of-tree workflows keep working.
  if (!e || !/external/i.test(String(e.action || ""))) return;
  let haystack = String(e.action || "");
  try {
    if (e.metadata) haystack += " " + JSON.stringify(e.metadata);
    if (e.source) haystack += " " + JSON.stringify(e.source);
  } catch {
    // Unserializable metadata — fall through to the fail-open path below.
  }
  if (!/write|edit|patch|apply|create|mkdir|move|copy|delete|remove|trash|rename/i.test(haystack)) return;
  const resources = Array.isArray(e.resources) ? e.resources : [];
  const outside = resources.filter((r) => typeof r === "string" && r && !isInsideDir(currentCwd, r));
  if (!outside.length) return;
  e.effect = "deny";
  e.message = `[GSD] worktree-path-guard: write outside the worktree is blocked: ${outside[0]}`;
}

function normalizeV2Event(input) {
  if (!input || typeof input !== "object") return null;
  const type = input.type ?? input.event?.type;
  if (typeof type !== "string") return null;
  const data = input.data ?? input.event?.properties ?? {};
  return { type, data: data && typeof data === "object" ? data : {} };
}

async function v2EventLoop(ctx, signal) {
  for await (const input of ctx.event.subscribe({ signal })) {
    if (signal && signal.aborted) break;
    const norm = normalizeV2Event(input);
    if (!norm) continue;
    if (norm.type === "session.created") {
      const sid = norm.data.sessionID ?? norm.data.info?.id;
      if (sid) currentSessionId = sid;
      const dir = norm.data.directory ?? norm.data.info?.directory;
      if (typeof dir === "string" && dir) currentCwd = dir;
    } else if (norm.type === "session.moved" || norm.type === "session.updated") {
      const dir = norm.data.directory ?? norm.data.to ?? norm.data.location?.directory;
      if (typeof dir === "string" && dir) currentCwd = dir;
    }
    // session.idle / session.error / permission.*: recognized no-ops, mirroring
    // the v1 sentinels — GSD state already lives in .planning/.
  }
}

// The v2 event bus has no file.edited — bridge the .planning/config.json
// reload with fs.watch (debounced). Returns an unwatch function or null.
function watchConfigReloadV2(cwd) {
  const file = path.join(cwd, ".planning", "config.json");
  let timer = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        handleHookResult(
          runHook("gsd-config-reload.js", {
            hook_event_name: "FileChanged",
            file_path: file,
            event: "change",
            cwd,
          }),
        );
      } catch (err) {
        console.error(`[gsd-core] config reload hook failed: ${err && err.message}`);
      }
    }, 300);
    if (timer.unref) timer.unref();
  };
  const watchers = [];
  try {
    watchers.push(fs.watch(file, fire));
  } catch {
    try {
      const w = fs.watch(path.dirname(file), (ev, name) => {
        if (name === "config.json") fire();
      });
      watchers.push(w);
    } catch {
      return null; // .planning not present — nothing to watch.
    }
  }
  return () => {
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
  };
}

async function gsdV2Setup(ctx) {
  if (ctx && ctx.location && typeof ctx.location.directory === "string" && ctx.location.directory) {
    currentCwd = ctx.location.directory;
  }
  const registrations = [];
  const register = async (domain, name, fn) => {
    try {
      const api = ctx && ctx[domain];
      if (!api || typeof api.hook !== "function") return;
      registrations.push(await api.hook(name, fn));
    } catch (err) {
      console.error(`[gsd-core] failed to register ${domain}.${name}: ${err && err.message}`);
    }
  };
  await register("shell", "create.before", v2ShellEnv);
  await register("tool", "execute.before", v2ExecuteBefore);
  await register("tool", "execute.after", v2ExecuteAfter);
  await register("session", "compaction", v2Compaction);
  await register("permission", "evaluate", v2PermissionEvaluate);

  const controller = new AbortController();
  let consume = null;
  try {
    if (ctx && ctx.event && typeof ctx.event.subscribe === "function") {
      consume = v2EventLoop(ctx, controller.signal).catch(() => {});
    }
  } catch {
    consume = null;
  }
  const unwatch = watchConfigReloadV2(currentCwd);

  return async () => {
    try { controller.abort(); } catch {}
    try { await consume; } catch {}
    if (typeof unwatch === "function") {
      try { unwatch(); } catch {}
    }
    for (const r of registrations.reverse()) {
      try { await r.dispose(); } catch {}
    }
  };
}

// Export shape — OpenCode v1 + v2 compatible.
//
// v1 loader iterates `Object.values(mod)` and accepts a bare function or an
// object exposing `.server` (hence `server` is kept, and `module.exports` is
// assigned from a VARIABLE so cjs-module-lexer cannot synthesize a stray
// string `id` named export that would trip its "not a function" throw).
//
// v2 loader (e.g. 2.0.24) instead validates the `default` export against a
// schema requiring `{ id, effect | setup }` — a bare `{ server }` object
// fails with `PluginModule.LoadError ... Missing key at ["default"]["setup"]`
// (server log `failed to load plugin`). So `setup` points at `gsdV2Setup`
// above — NOT at the v1 factory: v2 setup must return a cleanup function (or
// void), and a v1 hooks object returned here would be silently ignored.
// Both `id` and `setup` are NON-ENUMERABLE: v2 schema validation reads them
// via property access (verified live: no "missing id/setup" complaint), while
// the v1 `Object.values` loader walk still sees exactly `[server]`.
GsdCorePlugin._internals = {
  REPO_ROOT,
  IS_PACKAGE_TREE,
  mapToolName,
  mapToolInput,
  locateFrontmatterFence,
  parseFrontmatter,
  rewriteContent,
  isGsdManagedFile,
  handleHookResult,
  GsdCorePlugin,
  gsdV2Setup,
  resolveNodeBin,
  mapToolNameV2,
  extractV2ToolInput,
  v2FileTargets,
  collectResultTextSlots,
  normalizeV2Event,
  isInsideDir,
};

const gsdCorePluginExport = { server: GsdCorePlugin };
Object.defineProperty(gsdCorePluginExport, "id", {
  value: "gsd-core",
  enumerable: false,
  writable: false,
  configurable: false,
});
Object.defineProperty(gsdCorePluginExport, "setup", {
  value: gsdV2Setup,
  enumerable: false,
  writable: false,
  configurable: false,
});
module.exports = gsdCorePluginExport;
