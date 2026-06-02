#!/usr/bin/env node

const { loadAllSites, loadSite, getCommand, listCommands, listSites } = require("../src/registry.js");
const { ensureDaemon, shutdownDaemon, status, sendCommand, API, LOG_PATH } = require("../src/daemon-client.js");

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

function usage() {
  loadAllSites();
  const sites = listSites();
  const lines = [
    "Usage: mycli <site> <command> [args]",
    "       mycli daemon <start|stop|status|logs>",
    "",
    "Sites:",
  ];
  for (const site of sites) {
    const cmds = listCommands(site).map((c) => c.name).join(", ");
    lines.push(`  ${site.padEnd(12)} ${cmds}`);
  }
  lines.push("");
  lines.push("Examples:");
  lines.push('  mycli doubao ask --text "3+2 等于多少"');
  lines.push("  mycli doubao read --file ./file.md --out-dir ./audio");
  lines.push("  mycli doubao podcast --file ./material.pdf");
  lines.push("  mycli bilibili recent 402626075 123456789 --days 7 --limit 3");
  lines.push("");
  lines.push("Install the Tampermonkey userscript:");
  for (const site of sites) {
    lines.push(`  open ${API}/userscript/${site}/mycli.user.js`);
  }
  console.error(lines.join("\n"));
}

async function runSiteCommand(site, command, options, positional) {
  const loaded = loadSite(site);
  if (!loaded) {
    console.error(`Unknown site: ${site}`);
    process.exitCode = 1;
    return;
  }
  const spec = getCommand(site, command);
  if (!spec) {
    console.error(`Unknown command: ${site} ${command}`);
    console.error(`Available: ${listCommands(site).map((c) => c.name).join(", ") || "(none)"}`);
    process.exitCode = 1;
    return;
  }
  try {
    await spec.run({ options, positional, sendCommand, site, action: command });
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

async function daemonSubcommand(sub) {
  if (sub === "start") {
    const result = await ensureDaemon();
    if (result.spawned) {
      console.log(`mycli daemon started (pid ${result.pid}) at ${API}`);
      console.log(`log: ${LOG_PATH}`);
    } else {
      console.log(`mycli daemon already running at ${API}`);
    }
    return;
  }
  if (sub === "stop") {
    const result = await shutdownDaemon();
    console.log(result.wasRunning ? "mycli daemon stopped" : "mycli daemon was not running");
    return;
  }
  if (sub === "restart") {
    await shutdownDaemon();
    await new Promise((r) => setTimeout(r, 400));
    const result = await ensureDaemon();
    console.log(`mycli daemon restarted (pid ${result.pid ?? "?"})`);
    return;
  }
  if (sub === "status" || sub === undefined) {
    const data = await status();
    if (!data) {
      console.log("stopped");
      return;
    }
    console.log(`running at ${API} (pid ${data.pid}, uptime ${Math.round(data.uptime)}s)`);
    if (!data.sites.length) {
      console.log("connected sites: (none — install the userscript and open the page)");
    } else {
      console.log("connected sites:");
      for (const entry of data.sites) {
        console.log(`  ${entry.site} v${entry.version || "?"}  pending=${entry.pending}`);
      }
    }
    console.log(`log: ${LOG_PATH}`);
    return;
  }
  if (sub === "logs") {
    const fs = require("node:fs");
    const follow = process.argv.slice(3).some((a) => a === "-f" || a === "--follow");
    if (!fs.existsSync(LOG_PATH)) {
      if (!follow) {
        console.log("(no log yet)");
        return;
      }
      fs.writeFileSync(LOG_PATH, "");
    }
    if (!follow) {
      process.stdout.write(fs.readFileSync(LOG_PATH, "utf8"));
      return;
    }
    const { spawn } = require("node:child_process");
    const child = spawn("tail", ["-n", "200", "-f", LOG_PATH], { stdio: "inherit" });
    const stop = () => { try { child.kill("SIGINT"); } catch {} };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise((resolve) => child.on("exit", resolve));
    return;
  }
  console.error(`Unknown daemon subcommand: ${sub}`);
  process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    usage();
    return;
  }

  const [first, second, ...rest] = argv;

  if (first === "daemon") {
    return daemonSubcommand(second);
  }

  if (!second) {
    console.error(`Missing command for site "${first}".`);
    usage();
    process.exitCode = 1;
    return;
  }

  const { options, positional } = parseArgs(rest);
  return runSiteCommand(first, second, options, positional);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
