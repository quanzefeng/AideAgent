@echo off
REM ── Fake opencode (.cmd shim that wraps the Node fake server) ──
REM
REM This exists to prove that Node's `child_process.spawn()` can launch a
REM `.cmd` file on Windows WHEN `shell: true` is set. Without shell:true the
REM same spawn call returns EINVAL (verified empirically). See the
REM "Windows PATH lookup prefers .cmd" test in opencode-detector.test.mjs.
REM
REM We forward stdin/stdout via `more` so the JSON-RPC NDJSON stream flows
REM transparently between the ACP client (parent) and node (child).
node "%~dp0fake-acp-server.mjs" %*