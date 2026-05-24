process.stderr.write("[minimal_preload] RUNNING\n");
console.error("[minimal_preload] RUNNING via console.error\n");
try {
  const e = require("electron");
  console.error("[minimal_preload] electron loaded:", Object.keys(e).join(", "));
} catch (x) {
  console.error("[minimal_preload] require(electron) failed:", x.message);
}
