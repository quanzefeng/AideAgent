import { describe, it, expect } from "vitest";
import { parseFrontMatter } from "../core/skill-scanner.mjs";

describe("Skill Scanner", () => {
  describe("parseFrontMatter", () => {
    it("returns empty meta for text without front matter", () => {
      const result = parseFrontMatter("Just some content");
      // name_zh is the author-declared Chinese name field (added for the
      // 3-tier translation fallback). It defaults to empty when missing.
      expect(result).toEqual({ name: "", name_zh: "", description: "", triggers: [], allowed_tools: [] });
    });

    it("parses name_zh when present in front matter", () => {
      const text = `---
name: my-skill
name_zh: 我的技能
description: A test skill
---
Content here`;
      const result = parseFrontMatter(text);
      expect(result.name).toBe("my-skill");
      expect(result.name_zh).toBe("我的技能");
      expect(result.description).toBe("A test skill");
    });

    it("parses name and description", () => {
      const text = `---
name: my-skill
description: A test skill
---
Content here`;
      const result = parseFrontMatter(text);
      expect(result.name).toBe("my-skill");
      expect(result.description).toBe("A test skill");
    });

    it("parses triggers as comma-separated string", () => {
      const text = `---
name: test
triggers: hello, hi, hey
---`;
      const result = parseFrontMatter(text);
      expect(result.triggers).toEqual(["hello", "hi", "hey"]);
    });

    it("parses triggers as JSON array", () => {
      const text = `---
name: test
triggers: ["hello", "hi"]
---`;
      const result = parseFrontMatter(text);
      expect(result.triggers).toEqual(["hello", "hi"]);
    });

    it("parses allowed-tools as comma-separated string", () => {
      const text = `---
name: test
allowed-tools: bash, file_read
---`;
      const result = parseFrontMatter(text);
      expect(result["allowed-tools"]).toEqual(["bash", "file_read"]);
    });

    it("parses quoted values", () => {
      const text = `---
name: "my skill"
description: 'A description'
---`;
      const result = parseFrontMatter(text);
      expect(result.name).toBe("my skill");
      expect(result.description).toBe("A description");
    });

    it("handles empty front matter", () => {
      const text = `---
---
Content`;
      const result = parseFrontMatter(text);
      expect(result.name).toBe("");
      expect(result.description).toBe("");
    });

    it("ignores multi-line scalar values", () => {
      const text = `---
name: test
description: |
  This is a
  multi-line description
---`;
      const result = parseFrontMatter(text);
      expect(result.name).toBe("test");
      // description is a multi-line scalar, should be skipped
    });

    it("parses real SKILL.md format", () => {
      const text = `---
name: browse
description: Fast headless browser for QA testing
triggers: browse, open browser, test site
allowed-tools: Bash, Read, Write
---

# Browse Skill

This skill provides browser automation.
---`;
      const result = parseFrontMatter(text);
      expect(result.name).toBe("browse");
      expect(result.description).toBe("Fast headless browser for QA testing");
      expect(result.triggers).toEqual(["browse", "open browser", "test site"]);
      expect(result["allowed-tools"]).toEqual(["Bash", "Read", "Write"]);
    });
  });
});
