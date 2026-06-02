// PreToolUse 示例：拦截危险 bash 命令
// stdin 接收事件 JSON，stdout 输出 decision JSON

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", c => input += c);
process.stdin.on("end", () => {
  let event;
  try { event = JSON.parse(input); } catch {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  if (event.tool !== "bash") {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  const cmd = event.args?.command || "";

  // 1. PowerShell 危险操作
  if (/Invoke-Expression|iex|Start-Process\s+.*-Verb\s+RunAs/.test(cmd)) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: "PowerShell 危险操作被拦截" }));
    return;
  }

  // 2. 强制推送到 main/master
  if (/git\s+push\s+.*(--force|-f)\s+.*(main|master)/.test(cmd)) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: "禁止强制推送到 main/master" }));
    return;
  }

  // 3. 删除关键系统目录
  if (/rm\s+-rf\s+\/(\s|$)/.test(cmd) || /Remove-Item\s+.*-Recurse\s+.*(System32|Windows)/.test(cmd)) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: "禁止删除系统目录" }));
    return;
  }

  // 4. 数据外泄
  if (/curl.*-F\s|curl.*-d\s|wget.*--post/.test(cmd)) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: "疑似数据外发" }));
    return;
  }

  // 默认放行
  process.stdout.write(JSON.stringify({ decision: "allow" }));
});
