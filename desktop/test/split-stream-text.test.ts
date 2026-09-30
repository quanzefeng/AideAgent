import { describe, it, expect } from "vitest";
import { splitStreamText } from "../core/agent-loop.ts";

describe("splitStreamText", () => {
  it("moves pre-tool narration into reasoning and keeps only the answer as body", () => {
    const allText = "我先读取配置文件…\n\n现在检查日志。## 结果\n答案是 42";
    const { bodyText, reasoningText } = splitStreamText(allText, "", allText.indexOf("## 结果"));
    expect(bodyText).toBe("## 结果\n答案是 42");
    expect(reasoningText).toBe("我先读取配置文件…\n\n现在检查日志。");
  });

  it("keeps a single no-tool turn entirely as body text (boundary 0)", () => {
    const { bodyText, reasoningText } = splitStreamText("直接回答。", "思考中", 0);
    expect(bodyText).toBe("直接回答。");
    expect(reasoningText).toBe("思考中");
  });

  it("falls back to full text when there is no final-answer segment (abort mid-tool)", () => {
    const { bodyText, reasoningText } = splitStreamText("过程叙述", "r1", 8);
    expect(bodyText).toBe("过程叙述");
    expect(reasoningText).toBe("r1");
  });

  it("strips think tags from the answer and merges them into reasoning", () => {
    const allText = "过程\n<think>过程里的思考</think><think>答案前的思考</think>最终答案";
    const { bodyText, reasoningText } = splitStreamText(allText, "api-reasoning", 2);
    expect(bodyText).toBe("最终答案");
    expect(reasoningText).toContain("api-reasoning");
    expect(reasoningText).toContain("过程里的思考");
    expect(reasoningText).toContain("答案前的思考");
    expect(reasoningText).not.toContain("<think>");
  });

  it("clamps an out-of-range boundary", () => {
    const { bodyText } = splitStreamText("全文", "", 999);
    expect(bodyText).toBe("全文");
  });
});
