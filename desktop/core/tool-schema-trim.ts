// ── Phase 4: MCP tool-schema trimming ────────────────────────────────
//
// MCP servers ship raw, unoptimised JSON Schemas: `$schema` annotations,
// `additionalProperties: true`, multi-paragraph prose in every property
// description. Measured on this machine: the 3 running servers expose 38 tools
// = 30,008 JSON chars ≈ 7.5k tokens — ~30% of a bare "你好" request and half
// the tool-schema budget, and none of that text improves tool choice the way
// a hand-tuned description does.
//
// ONLY MCP defs get description caps. Built-in descriptions are hand-written
// for tool-choice quality (see the header of tool-definitions.ts) and are left
// byte-identical; applying schema-noise stripping to them is still safe
// (they don't carry these keys), so callers may pass BUILTIN_TRIM_OPTIONS.

export interface TrimOptions {
  /** Max chars for the top-level tool description (Infinity = keep as-is). */
  toolDescCap: number;
  /** Max chars for any nested property/enum description. */
  propDescCap: number;
}

/**
 * Tuned on real servers running on this machine (playwright 25 / searxng 4 /
 * computer-use 9 tools = 30,898 chars ≈ 7,730 tok):
 *   noise-only strip:  -356 tok
 *   500/160:           -850 tok
 *   400/140:           -953 tok   ← chosen (≈12% off the MCP schema budget)
 *   300/100:         -1,211 tok   (starts cutting usage guidance out of
 *                                  descriptions that the model needs)
 * computer-use loses nothing to the caps (its longest description is 253
 * chars) — its share is pure schema structure and cannot be trimmed safely.
 */
export const MCP_TRIM_OPTIONS: TrimOptions = { toolDescCap: 400, propDescCap: 140 };

/** Pass-through options: strips annotation keys only, never shortens prose. */
export const BUILTIN_TRIM_OPTIONS: TrimOptions = { toolDescCap: Infinity, propDescCap: Infinity };

let _enabled = true;
/** Kill-switch (tests / rollback): when false, trimToolDefs returns input as-is. */
export function setMcpSchemaTrimEnabled(v: boolean): void { _enabled = v; }
export function isMcpSchemaTrimEnabled(): boolean { return _enabled; }

/**
 * Pure annotation keys — deleting them cannot change how a tool is invoked.
 * `x-*` is the JSON-Schema extension namespace (vendor metadata).
 *
 * CAUTION: these names are only annotations when they appear as keys OF a
 * schema node. Inside a `properties`/`$defs` map the keys are user-facing
 * argument names (gh_pr has a real `title` property!), so the map itself is
 * traversed in name-preserving mode.
 */
const DROP_KEYS = new Set(["$schema", "$id", "$comment", "title", "examples"]);
/** Keys whose value is a NAME → schema map, not a schema node. */
const NAME_MAP_KEYS = new Set(["properties", "patternProperties", "definitions", "$defs"]);

/** Deep-copy a JSON Schema, stripping noise and capping descriptions. */
export function trimSchemaNode(node: any, propDescCap: number, depth = 0, nameMap = false): any {
  if (depth > 16 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(v => trimSchemaNode(v, propDescCap, depth + 1, false));
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (!nameMap) {
      if (DROP_KEYS.has(k) || k.startsWith("x-")) continue;
      // `additionalProperties: true` is the JSON-Schema default → pure noise.
      // `false`/a schema is RESTRICTIVE — dropping it would let the model emit
      // args the server then rejects, so those are kept.
      if (k === "additionalProperties" && v === true) continue;
      if (k === "description" && typeof v === "string" && v.length > propDescCap) {
        out[k] = v.slice(0, propDescCap).trimEnd() + "…";
        continue;
      }
    }
    out[k] = trimSchemaNode(v, propDescCap, depth + 1, !nameMap && NAME_MAP_KEYS.has(k));
  }
  return out;
}

export interface ToolDefLike {
  type?: string;
  function: { name: string; description?: string; parameters?: object; [k: string]: any };
  [k: string]: any;
}

export function trimToolDef<T extends ToolDefLike>(def: T, opts: TrimOptions = MCP_TRIM_OPTIONS): T {
  const fn = def?.function;
  if (!fn) return def;
  let description = typeof fn.description === "string" ? fn.description : "";
  if (description.length > opts.toolDescCap) {
    description = description.slice(0, opts.toolDescCap).trimEnd() + "…";
  }
  return {
    ...def,
    function: {
      ...fn,
      description,
      parameters: trimSchemaNode(fn.parameters ?? {}, opts.propDescCap),
    },
  };
}

/** JSON size of a def array — the unit we optimise. */
export function defsChars(defs: any[]): number {
  try { return JSON.stringify(defs || []).length; } catch { return 0; }
}

/**
 * Trim every def (returns a new array; input untouched). When trimming is
 * disabled the input array is returned unchanged.
 */
export function trimToolDefs(defs: any[], opts: TrimOptions = MCP_TRIM_OPTIONS): any[] {
  if (!_enabled || !Array.isArray(defs) || defs.length === 0) return defs;
  return defs.map(d => trimToolDef(d, opts));
}
