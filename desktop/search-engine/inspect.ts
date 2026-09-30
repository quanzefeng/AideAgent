// Inspect what Baidu mobile actually returns
async function main() {
  const res = await fetch("https://m.baidu.com/s?word=Node.js", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    },
  });
  const html = await res.text();

  // Check for captcha
  if (/captcha|验证码|安全验证|antispider/i.test(html)) {
    console.log("BAIDU: captcha challenge");
    return;
  }

  // Find all <div class="result..."> open tags
  const divMatch = html.matchAll(/<div[^>]*class="([^"]*)"[^>]*>/g);
  const classes = new Set<string>();
  let count = 0;
  for (const m of divMatch) {
    if (m[1].includes("result")) {
      classes.add(m[1]);
      count++;
    }
  }
  console.log("Baidu result div classes found:", count, "unique:", classes.size);
  for (const c of classes) {
    const re = new RegExp(`<div[^>]*class="${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)<\\/div>`, "g");
    let cnt = 0;
    let m;
    while ((m = re.exec(html)) !== null && cnt < 3) {
      cnt++;
      const block = m[1].slice(0, 300);
      // Check for real links
      const links = block.match(/href="https?:\/\/([^"]+)"/);
      const titleBlock = block.match(/<(?:div|h3)[^>]*class="[^"]*\bt\b[^"]*"[^>]*>/);
      console.log(`  [${c}] block ${cnt}: hasLink=${!!links} hasTitle=${!!titleBlock} preview=${block.slice(0, 100).replace(/\n/g, " ")}`);
    }
  }

  // Also check Sogou
  console.log("\n=== Sogou HTML check ===");
  try {
    const r2 = await fetch("https://www.sogou.com/web?query=Node.js", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
    });
    const html2 = await r2.text();
    if (/captcha|验证码|antispider|请输入验证码/i.test(html2)) {
      console.log("Sogou: captcha challenge - first 500 chars:");
      console.log(html2.slice(0, 500));
      return;
    }
    // Check for vrwrap
    const vrwrap = html2.match(/<div[^>]*class="vrwrap"[^>]*>/g);
    console.log("Sogou vrwrap count:", vrwrap ? vrwrap.length : 0);
    const vrTitle = html2.match(/<h3[^>]*class="[^"]*vr[Tt]itle[^"]*"[^>]*>/g);
    console.log("Sogou vrTitle count:", vrTitle ? vrTitle.length : 0);
    if (!vrTitle) console.log("Sogou first 1000 chars:", html2.slice(0, 1000));
  } catch (e: any) {
    console.log("Sogou error:", e.message);
  }
}

main().catch(console.error);
