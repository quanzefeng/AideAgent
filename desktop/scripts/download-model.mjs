// Download Xenova/all-MiniLM-L6-v2 ONNX model files for offline use
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, "..", "models", "all-MiniLM-L6-v2");

// Try mirror first (for users in China), fall back to official
const BASES = [
  "https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/resolve/main",
  "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main",
];

const FILES = [
  "config.json",
  "tokenizer.json",
  "onnx/model_quantized.onnx",
];

async function download(url, dest, timeoutMs = 60000) {
  const dir = dirname(dest);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(dest)) {
    console.log(`  skip (exists): ${dest}`);
    return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);

    const stream = createWriteStream(dest);
    const total = parseInt(res.headers.get("content-length") || "0", 10);
    let downloaded = 0;

    for await (const chunk of res.body) {
      stream.write(chunk);
      downloaded += chunk.length;
      if (total > 0) {
        process.stdout.write(`\r  ${Math.round(downloaded / total * 100)}%`);
      }
    }
    stream.end();
    console.log(`\r  done (${(downloaded / 1024 / 1024).toFixed(1)} MB): ${dest}`);
  } finally {
    clearTimeout(timer);
  }
}

console.log("Downloading MiniLM-L6-v2 ONNX model...");
for (const file of FILES) {
  console.log(`  ${file}`);
  let ok = false;
  for (const base of BASES) {
    try {
      await download(`${base}/${file}`, join(MODELS_DIR, file));
      ok = true;
      break;
    } catch (e) {
      console.log(`    ${base} failed: ${e.message}`);
    }
  }
  if (!ok) {
    console.error(`  FAILED: ${file} — please download manually`);
    process.exit(1);
  }
}
console.log("Done.");
