@echo off
REM ── Fake opencode ACP server (.cmd shim) ─────────────────────
REM
REM This is a self-contained .cmd batch script that speaks the Agent Client
REM Protocol over stdio. It's used by opencode-acp-client.test.mjs to verify
REM that Node's `child_process.spawn()` can launch a .cmd shim on Windows
REM (which requires `shell: true` — see opencode-acp-client.mjs).
REM
REM Protocol: same as fake-acp-server.mjs (node version).
REM Reads JSON-RPC 2.0 from stdin, writes NDJSON to stdout.
setlocal enabledelayedexpansion

:main
set "line="
:getline
set /p "line=" || goto :eof
if "!line!"=="" goto :getline

REM Parse the id out of the line using a quick batch trick.
REM We don't need full JSON parsing — just need to find "method":"...".
for /f "tokens=2 delims=:," %%a in ("!line!") do (
    set "key=%%a"
    set "key=!key:"=!"
    if "!key!"=="id" (
        set "tmp=!line:*"id":=!"
        for /f "delims=,}" %%b in ("!tmp!") do set "id=%%b"
    )
)

REM Initialize
echo !line! | findstr /C:"\"method\":\"initialize\"" >nul
if !errorlevel!==0 (
    echo {"jsonrpc":"2.0","id":!id!,"result":{"protocolVersion":1,"capabilities":{"tools":true,"streaming":true},"agentInfo":{"name":"fake-cmd-shim","version":"0.0.0"}}}
    goto :getline
)

REM session/new
echo !line! | findstr /C:"\"method\":\"session/new\"" >nul
if !errorlevel!==0 (
    echo {"jsonrpc":"2.0","id":!id!,"result":{"sessionId":"fake-cmd-1"}}
    goto :getline
)

REM session/prompt — emit 2 chunks + response
echo !line! | findstr /C:"\"method\":\"session/prompt\"" >nul
if !errorlevel!==0 (
    echo {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake-cmd-1","update":{"type":"agent_message_chunk","content":"Hello "}}}
    echo {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake-cmd-1","update":{"type":"agent_message_chunk","content":"from .cmd shim."}}}
    echo {"jsonrpc":"2.0","id":!id!,"result":{"stopReason":"end_turn"}}
    goto :getline
)

REM shutdown
echo !line! | findstr /C:"\"method\":\"shutdown\"" >nul
if !errorlevel!==0 (
    echo {"jsonrpc":"2.0","id":!id!,"result":{}}
    exit /b 0
)

REM Unknown method — error
echo {"jsonrpc":"2.0","id":!id!,"error":{"code":-32601,"message":"method not found"}}
goto :getline