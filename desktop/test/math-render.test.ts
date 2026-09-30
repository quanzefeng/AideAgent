import { describe, it, expect } from "vitest";
import {
  repairTex,
  looksLikeBareLatex,
  wrapBareLatexRuns,
  splitBareLatexSegments,
  normFormula,
} from "../renderer/modules/helpers.ts";

describe("repairTex", () => {
  it("fixes lost-backslash row break \\4pt]", () => {
    expect(repairTex("x \\4pt] y")).toBe("x \\\\[4pt] y");
  });

  it("strips unbalanced closing braces", () => {
    expect(repairTex("\\frac{a}{b}")).toBe("\\frac{a}{b}");
    expect(repairTex("\\frac{a}{b}}")).toBe("\\frac{a}{b}");
  });

  it("passes through valid tex", () => {
    expect(repairTex("x^2 + y^2 = z^2")).toBe("x^2 + y^2 = z^2");
  });

  it("handles empty", () => {
    expect(repairTex("")).toBe("");
    expect(repairTex(null)).toBe("");
  });

  it("strips tofu and fixes \\&= inside aligned", () => {
    const bad = "\\begin{aligned}a \\&= b\\tag*{■}\\end{aligned}";
    const fixed = repairTex(bad);
    expect(fixed).not.toContain("■");
    expect(fixed).not.toContain("\\&");
    expect(fixed).toContain("&=");
    expect(fixed).toContain("\\begin{aligned}");
    expect(fixed).toContain("\\end{aligned}");
  });

  it("peels plain noise around a complete env", () => {
    const mixed = "c2=b2-2ab\\begin{aligned}a&=b\\end{aligned}extra";
    const fixed = repairTex(mixed);
    expect(fixed).toBe("\\begin{aligned}a&=b\\end{aligned}");
  });
});

describe("normFormula", () => {
  it("normalizes unicode exponents and latex markers", () => {
    expect(normFormula("c² = a² + b²")).toBe(normFormula("c^2 = a^2 + b^2"));
    expect(normFormula("A = (b, 0), B = (a cos C, a sin C)")).toBe(
      normFormula("A=(b,0),B=(acosC,asinC)"),
    );
  });
});

describe("looksLikeBareLatex", () => {
  it("detects common bare formulas", () => {
    expect(looksLikeBareLatex("\\Delta = b^2 - 4ac")).toBe(true);
    expect(looksLikeBareLatex("x_1 + x_2 = -\\dfrac{b}{a}")).toBe(true);
    expect(looksLikeBareLatex("\\blacksquare")).toBe(true);
    expect(looksLikeBareLatex("\\frac{-b + \\sqrt{\\Delta}}{2a}")).toBe(true);
    expect(looksLikeBareLatex("-a(x_1 + x_2) = b \\Longrightarrow x_1 + x_2")).toBe(true);
  });

  it("rejects non-math", () => {
    expect(looksLikeBareLatex("hello world")).toBe(false);
    expect(looksLikeBareLatex("C:\\Users\\foo\\bar")).toBe(false);
    expect(looksLikeBareLatex("D:\\AideAgent\\desktop")).toBe(false);
    expect(looksLikeBareLatex("价格是 100 元")).toBe(false);
    expect(looksLikeBareLatex("$x + y$")).toBe(false);
    expect(looksLikeBareLatex("\\(x + y\\)")).toBe(false);
    expect(looksLikeBareLatex("")).toBe(false);
  });

  it("rejects glued multi-formula blobs (model repetition)", () => {
    const glued =
      "P(x)=axn+an-1(a≠0)P(x)=a_n x^n+a_{n-1}(a_n≠0)P(x)=axn+an-1(a≠0)";
    expect(looksLikeBareLatex(glued)).toBe(false);
  });
});

describe("splitBareLatexSegments", () => {
  it("splits on newlines", () => {
    expect(splitBareLatexSegments("a=1\nb=2")).toEqual(["a=1", "b=2"]);
  });

  it("splits glued f(x)= repetitions", () => {
    const glued = "P(x)=axn+(a≠0)P(x)=a_n x^n+(a_n≠0)P(x)=axn+(a≠0)";
    const parts = splitBareLatexSegments(glued);
    expect(parts.length).toBe(3);
    expect(parts[0]).toContain("P(x)=axn+");
    expect(parts[1]).toContain("a_n x^n");
  });

  it("keeps a single formula intact", () => {
    expect(splitBareLatexSegments("x_1 + x_2 = -b/a")).toEqual(["x_1 + x_2 = -b/a"]);
  });
});

describe("wrapBareLatexRuns", () => {
  it("wraps math segments and leaves Chinese prose alone", () => {
    const out = wrapBareLatexRuns("判别式 \\Delta = b^2 - 4ac ，由求根公式");
    expect(out).toContain('class="kp"');
    expect(out).toContain("判别式");
    expect(out).toContain("由求根公式");
    expect(out).toContain("\\Delta = b^2 - 4ac");
  });

  it("leaves already-delimited math alone", () => {
    const input = "行内 $x + y$ 已有分隔符";
    expect(wrapBareLatexRuns(input)).toBe(input);
  });

  it("leaves pure prose alone", () => {
    const input = "这是一段普通中文说明。";
    expect(wrapBareLatexRuns(input)).toBe(input);
  });

  it("does not glue repeated model formulas into one kp", () => {
    const glued =
      "P(x)=axn+(a≠0)P(x)=a_n x^n+(a_n≠0)P(x)=axn+(a≠0)";
    const out = wrapBareLatexRuns(glued);
    const kpCount = (out.match(/class="kp"/g) || []).length;
    expect(kpCount).toBeLessThanOrEqual(2);
    expect(out).not.toContain('class="kp">' + glued);
  });

  it("keeps complete aligned env atomic and display", () => {
    const env = "\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}";
    const out = wrapBareLatexRuns("证明：\n" + env + "\n证毕");
    expect(out).toContain('data-m="d"');
    expect(out).toContain("\\begin{aligned}");
    expect(out).toContain("\\end{aligned}");
    // must not tear the env across multiple kp spans
    const begins = (out.match(/\\begin\{aligned\}/g) || []).length;
    expect(begins).toBe(1);
  });

  it("dedupes triple-copied plain/latex formulas", () => {
    const a = "c2 = a2 + b2 − 2abcosC";
    const b = "c² = a² + b² − 2ab cos C";
    const c = "c^2 = a^2 + b^2 - 2ab\\cos C";
    const out = wrapBareLatexRuns(a + " " + b + " " + c);
    // collapse immediate duplicate runs + dedupe similar math → at most one kp
    const kpCount = (out.match(/class="kp"/g) || []).length;
    expect(kpCount).toBeLessThanOrEqual(1);
  });

  it("collapses immediate triple repeats like ∠C∠C∠C", () => {
    const parts = splitBareLatexSegments("∠C∠C∠C");
    expect(parts.join("")).toBe("∠C");
  });

  it("does not tear multi-line aligned across formula splits", () => {
    const env = "\\begin{aligned}x &= 1 \\\\ y &= 2\\end{aligned}";
    const parts = splitBareLatexSegments(env);
    expect(parts.length).toBe(1);
    expect(parts[0]).toContain("\\begin{aligned}");
    expect(parts[0]).toContain("\\end{aligned}");
  });

  it("preserves blank lines between content lines", () => {
    const parts = splitBareLatexSegments("## Title\n\nbody x^2\n\n| a | b |");
    expect(parts[0]).toBe("## Title");
    expect(parts[1]).toBe("");
    expect(parts[2]).toContain("body");
    expect(parts[parts.length - 1]).toBe("| a | b |");
  });
});

describe("wrapBareLatexRuns markdown structure", () => {
  it("preserves newlines so marked can parse headings/tables", () => {
    const input = "## 标题\n\n正文说明\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    expect(wrapBareLatexRuns(input)).toBe(input);
  });

  it("keeps paragraph breaks around bare math", () => {
    const input = "第一段 \\Delta = b^2 - 4ac\n\n第二段结束";
    const out = wrapBareLatexRuns(input);
    expect(out).toContain('class="kp"');
    expect(out).toContain("\n\n");
    expect(out.split("\n").length).toBe(input.split("\n").length);
  });
});
