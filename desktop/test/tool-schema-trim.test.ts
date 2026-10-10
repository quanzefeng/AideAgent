import { describe, it, expect } from "vitest";
import {
  trimSchemaNode, trimToolDef, trimToolDefs, defsChars,
  setMcpSchemaTrimEnabled, isMcpSchemaTrimEnabled,
  MCP_TRIM_OPTIONS, BUILTIN_TRIM_OPTIONS,
} from "../core/tool-schema-trim.ts";
import { TOOL_DEFS } from "../core/tool-definitions.ts";

describe("tool schema trim (Phase 4)", () => {
  it("strips annotation keys and vendor metadata", () => {
    const schema = {
      type: "object",
      $schema: "http://json-schema.org/draft/2020-12/schema",
      $id: "https://example.com/tool",
      $comment: "internal",
      title: "ToolArgs",
      examples: [{ a: 1 }],
      "x-vendor": "meta",
      properties: { a: { type: "string" } },
    };
    const out = trimSchemaNode(schema, MCP_TRIM_OPTIONS.propDescCap);
    expect(out).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("drops additionalProperties:true but keeps restrictive forms", () => {
    const out = trimSchemaNode({
      type: "object",
      properties: {},
      additionalProperties: true,
      nested: { type: "object", additionalProperties: false },
      other: { type: "object", additionalProperties: { type: "string" } },
    }, 100);
    expect(out.additionalProperties).toBeUndefined();
    expect(out.nested.additionalProperties).toBe(false);
    expect(out.other.additionalProperties).toEqual({ type: "string" });
  });

  it("caps property descriptions but keeps short ones verbatim", () => {
    const cap = MCP_TRIM_OPTIONS.propDescCap;
    const out = trimSchemaNode({
      type: "object",
      properties: {
        short: { type: "string", description: "selector" },
        long: { type: "string", description: "p".repeat(cap + 500) },
      },
    }, cap);
    expect(out.properties.short.description).toBe("selector");
    expect(out.properties.long.description.length).toBe(cap + 1);
    expect(out.properties.long.description.endsWith("…")).toBe(true);
  });

  it("caps the tool description and leaves short ones alone", () => {
    const long = trimToolDef({
      type: "function",
      function: { name: "mcp_tool", description: "d".repeat(MCP_TRIM_OPTIONS.toolDescCap + 900), parameters: { type: "object" } },
    });
    expect(long.function.description.length).toBe(MCP_TRIM_OPTIONS.toolDescCap + 1);
    expect(long.function.description.endsWith("…")).toBe(true);

    const short = trimToolDef({
      type: "function",
      function: { name: "mcp_tool", description: "navigate somewhere", parameters: { type: "object" } },
    });
    expect(short.function.description).toBe("navigate somewhere");
  });

  it("preserves everything that drives argument generation", () => {
    const def = {
      type: "function",
      function: {
        name: "searxng_search",
        description: "x".repeat(900),
        parameters: {
          type: "object",
          $schema: "nope",
          properties: {
            q: { type: "string", description: "y".repeat(400) },
            page: { type: "integer", minimum: 1, maximum: 50, default: 1 },
            format: { type: "string", enum: ["json", "html"] },
          },
          required: ["q"],
          additionalProperties: false,
        },
      },
    };
    const out = trimToolDef(def);
    const p = out.function.parameters as any;
    expect(p.required).toEqual(["q"]);
    expect(p.properties.q.type).toBe("string");
    expect(p.properties.page).toEqual({ type: "integer", minimum: 1, maximum: 50, default: 1 });
    expect(p.properties.format.enum).toEqual(["json", "html"]);
    expect(p.additionalProperties).toBe(false);
    // idempotent: trimming twice changes nothing further
    expect(JSON.stringify(trimToolDef(out))).toBe(JSON.stringify(out));
  });

  it("keeps real argument names that collide with annotation keys", () => {
    // gh_pr/gh_issue expose a genuine `title` PROPERTY — annotation stripping
    // must only apply to schema nodes, never to names inside `properties`.
    const params = TOOL_DEFS.find(d => d.function.name === "gh_pr")!.function.parameters as any;
    expect(params.properties.title).toBeTruthy();
    const out = trimToolDef(TOOL_DEFS.find(d => d.function.name === "gh_pr")!);
    const outParams = out.function.parameters as any;
    expect(outParams.properties.title).toEqual(params.properties.title);
    expect(outParams.properties.title.type).toBe("string");
  });

  it("leaves built-in descriptions byte-identical under BUILTIN_TRIM_OPTIONS", () => {
    const before = JSON.stringify(TOOL_DEFS);
    const after = JSON.stringify(TOOL_DEFS.map(d => trimToolDef(d, BUILTIN_TRIM_OPTIONS)));
    expect(after).toBe(before);
    expect(BUILTIN_TRIM_OPTIONS.toolDescCap).toBe(Infinity);
  });

  it("reports char savings and honours the kill switch", () => {
    const defs = [
      { type: "function", function: { name: "a", description: "z".repeat(1000), parameters: { type: "object", $schema: "s" } } },
      { type: "function", function: { name: "b", description: "ok", parameters: { type: "object" } } },
    ];
    expect(defsChars(defs)).toBeGreaterThan(defsChars(trimToolDefs(defs)));

    const original = trimToolDefs(defs);
    expect(original).not.toBe(defs);
    setMcpSchemaTrimEnabled(false);
    try {
      expect(isMcpSchemaTrimEnabled()).toBe(false);
      expect(trimToolDefs(defs)).toBe(defs);
    } finally {
      setMcpSchemaTrimEnabled(true);
    }
    expect(isMcpSchemaTrimEnabled()).toBe(true);
  });
});
