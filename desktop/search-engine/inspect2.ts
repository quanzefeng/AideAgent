// Inspect Sogou vrwrap content
async function main() {
  const res = await fetch("https://www.sogou.com/web?query=Node.js", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  });
  const html = await res.text();

  // Find all vrwrap blocks
  const vrwrapRe = /<div[^>]*class="vrwrap"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let m;
  let idx = 0;
  while ((m = vrwrapRe.exec(html)) !== null && idx < 3) {
    const block = m[1].slice(0, 500);
    // Find any h3 or <a> tags
    const h3s = m[1].match(/<h3[^>]*>/gi);
    const links = m[1].match(/<a[^>]*href="https?:\/\/([^"]+)"[^>]*>/gi);
    console.log(`vrwrap ${idx}:`);
    console.log(`  h3 count: ${h3s ? h3s.length : 0}`);
    console.log(`  link count: ${links ? links.length : 0}`);
    if (h3s) {
      for (const h of h3s) console.log(`  h3: ${h}`);
    }
    if (links) links.slice(0, 2).forEach((l) => console.log(`  link: ${l.slice(0, 120)}`));
    console.log(`  preview: ${block.slice(0, 200).replace(/\n/g, " ")}`);
    console.log();
    idx++;
  }

  // Also check Baidu desktop
  console.log("=== Baidu Desktop ===");
  const r2 = await fetch("https://www.baidu.com/s?wd=Node.js", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  });
  const html2 = await r2.text();
  if (/captcha|验证码|安全验证|antispider/i.test(html2)) {
    console.log("Baidu desktop: captcha challenge");
  } else {
    const cContainers = html2.match(/<div[^>]*class="[^"]*\bc-container\b[^"]*"[^>]*>/g);
    console.log("Baidu c-container count:", cContainers ? cContainers.length : 0);
    if (cContainers) {
      [...new Set(cContainers)].slice(0, 5).forEach(c => console.log(" ", c));
    }
    // Check for result divs
    const resultDivs = html2.match(/<div[^>]*class="[^"]*result[^"]*"[^>]*>/g);
    console.log("Baidu result divs:", resultDivs ? resultDivs.length : 0);
    if (resultDivs) {
      [...new Set(resultDivs)].slice(0, 5).forEach(c => console.log(" ", c));
    }
  }
}

main().catch(console.error);
