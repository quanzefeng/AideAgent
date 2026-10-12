import { describe, it, expect } from "vitest";
import {
  repairTex,
  looksLikeBareLatex,
  wrapBareLatexRuns,
  splitBareLatexSegments,
  normFormula,
  preprocessMath,
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

  it("rejects markdown table rows (subscript cells must not swallow the row)", () => {
    expect(looksLikeBareLatex("|Q2_0|2.40|37.6GB|28.8GB|66.4GB|")).toBe(false);
    expect(looksLikeBareLatex("|IQ2_XS(2.50bpw)|77.16|100.3|")).toBe(false);
    expect(looksLikeBareLatex("| log | 3.2 | 1.1 |")).toBe(false);
    expect(looksLikeBareLatex("  | a_b | c | d |")).toBe(false);
    expect(looksLikeBareLatex("|x_1| + |y_1|")).toBe(false); // leading pipe + ≥3 pipes → treated as table row
  });

  it("never swallows markdown block markers (same class as table-pipe bug)", () => {
    expect(looksLikeBareLatex("- IQ3_S")).toBe(false);
    expect(looksLikeBareLatex("- Q2_0")).toBe(false);
    expect(looksLikeBareLatex("> x_1 + x_2")).toBe(false);
    expect(looksLikeBareLatex("* IQ3_XXS")).toBe(false);
    expect(looksLikeBareLatex("## GSQ_2")).toBe(false);
    // genuine bare formulas still wrap (no space after the minus, etc.)
    expect(looksLikeBareLatex("-a(x_1 + x_2) = b \\Longrightarrow c")).toBe(true);
    expect(looksLikeBareLatex("x_1 + x_2 = -b/a")).toBe(true);
  });
});

describe("splitBareLatexSegments", () => {
  it("splits on newlines", () => {
    expect(splitBareLatexSegments("a=1\nb=2")).toEqual(["a=1", "b=2"]);
  });

  it("keeps markdown table rows intact (no mid-row splits)", () => {
    const row = "| f(1)=2 | g(2)=3 | h(3)=4 |";
    expect(splitBareLatexSegments(row)).toEqual([row]);
    expect(splitBareLatexSegments("| A=B | A=B | A=B |")).toEqual(["| A=B | A=B | A=B |"]);
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

describe("wrapBareLatexRuns (tables)", () => {
  it("keeps CJK table rows atomic — cell pipes must never enter a .kp span", () => {
    const rows = [
      "| 你的显存/用途 | 推荐档位 |",
      "| 64 GB 以上显存，追求最高质量 | **IQ3_S（83.6 GB，驻留 54.8 GB）** |",
      "| 48–64 GB，质量/体积平衡 | **IQ3_XXS（75.8 GB，驻留 47 GB）**——多数人的最佳选择 |",
      "| 40 GB 级别，磁盘 mmap 分片 2 | IQ2_XS（68 GB） |",
      "| 追求吞吐（服务场景、长上下文） | **Q2_0（66.4 GB）**，prompt 吞吐碾压其他档 |",
    ];
    const src = rows.join("\n");
    const out = wrapBareLatexRuns(src);
    expect(out).toBe(src); // untouched: no kp wrap, pipes all survive
    expect(out).not.toContain('class="kp"');
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

describe("preprocessMath — env body regression", () => {
  // Bug (2026-10-12): the \begin{env} rule destructured (match, env, body)
  // but the regex had only ONE capture group, so `body` silently received
  // the match OFFSET — \begin{cases}0,&x<0\\ 1,&x\ge 0\end{cases} rendered
  // as \begin{cases}5627\end{cases} in a 6k-char FTC proof.
  it("keeps \\begin{cases} body intact instead of the match offset", () => {
    const prefix = "x".repeat(200); // non-trivial offset inside the message
    const text = `设\n\n${prefix}\n\n$$f(x)=\\begin{cases}0,&x<0\\\\ 1,&x\\ge 0\\end{cases}$$\n\n则 $F(x)$。`;
    const { mathStore } = preprocessMath(text);
    const cases = mathStore.find(x => x.tex.includes("\\begin{cases}"));
    expect(cases).toBeTruthy();
    expect(cases!.tex).toContain("0,&x<0");
    expect(cases!.tex).toContain("1,&x\\ge 0");
    // The old bug injected the numeric offset as the whole body
    expect(cases!.tex).not.toMatch(/\\begin\{cases\}\d+\\end\{cases\}/);
    expect(cases!.mode).toBe("d");
  });

  it("wraps ALL bare envs, not just the first (global rule)", () => {
    const text = "行一\n\\begin{aligned}a&=b\\end{aligned}\n行二\n\\begin{cases}x\\end{cases}";
    const { mathStore } = preprocessMath(text);
    const envs = mathStore.filter(m => m.tex.includes("\\begin"));
    expect(envs.length).toBe(2);
  });

  it("does not re-wrap envs already inside $$..$$ spans (no nested .kp)", () => {
    const text = "$$\\begin{cases}a\\\\b\\end{cases}$$\n\n正文\n\n\\begin{aligned}c&=d\\end{aligned}";
    const { src, mathStore } = preprocessMath(text);
    // No live span should survive extraction; tokens only
    expect(src).not.toContain('<span class="kp"');
    // Exactly two math items, each a clean env (no span markup inside tex)
    const envs = mathStore.filter(m => m.tex.includes("\\begin"));
    expect(envs.length).toBe(2);
    for (const e of envs) expect(e.tex).not.toContain('<span class="kp"');
  });

  it("preserves the full two-row cases body through the pipeline", () => {
    // Exact fragment from the FTC-proof message (id 7294)
    const text = '2. **$f$ 有跳跃间断时 $F$ 不可导**。设\n$$f(x)=\\begin{cases}0,&x<0\\\\ 1,&x\\ge 0\\end{cases}$$\n则 $F(x)=\\int_0^x f$ 在 $x=0$ 处连续但不可导：右导数 $=1$，左导数 $=0$。';
    const { mathStore } = preprocessMath(text);
    const texs = mathStore.map(m => m.tex);
    expect(texs.some(t => t.includes("f(x)=\\begin{cases}0,&x<0\\\\ 1,&x\\ge 0\\end{cases}"))).toBe(true);
  });
});

describe("preprocessMath — inline $...$ heuristics", () => {
  it("math-izes operator-led fragments ($=1$, $=0$)", () => {
    const { mathStore } = preprocessMath("右导数 $=1$，左导数 $=0$。");
    const texs = mathStore.map(m => m.tex);
    expect(texs).toContain("=1");
    expect(texs).toContain("=0");
  });

  it("math-izes short numeric fragments ($1$, $0$, $0,1$) — paired $ is never currency", () => {
    const { mathStore } = preprocessMath("恒为 $1$ 与恒为 $0$，取 $0,1$ 两值。");
    const texs = mathStore.map(m => m.tex);
    expect(texs).toContain("1");
    expect(texs).toContain("0");
    expect(texs).toContain("0,1");
  });

  it("keeps primes ($G'$) as math", () => {
    const { mathStore } = preprocessMath("若存在 $G'=f$，则 $G'$ 在 $x$ 处");
    const texs = mathStore.map(m => m.tex);
    expect(texs.some(t => t.includes("G'"))).toBe(true);
  });
});
