import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// config-stack reads from fixed paths, so we test the individual helpers
// by checking they return sane types and don't crash on missing data
import {
  collectMcpServers,
  collectHooks,
  collectClaudeMdStats,
  collectEnvironment,
} from "../reporter/config-stack";

describe("config-stack", () => {
  describe("collectMcpServers", () => {
    it("returns an array", () => {
      const result = collectMcpServers();
      assert.ok(Array.isArray(result));
    });

    it("never includes credentials or URLs", () => {
      const result = collectMcpServers();
      const serialized = JSON.stringify(result);
      // Should only contain server names, not URLs or tokens
      assert.ok(!serialized.includes("http"));
      assert.ok(!serialized.includes("Bearer"));
      assert.ok(!serialized.includes("sk-"));
    });
  });

  // Hosts that inject their MCP servers at runtime (Sparkle does this) never write
  // an mcpServers block, so reading that key alone reported nothing. The permission
  // patterns the host leaves behind are the only on-disk trace of those servers.
  describe("collectMcpServers — derived from permission patterns", () => {
    let tmpDir;
    let settingsPath;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-mcp-"));
      settingsPath = path.join(tmpDir, "settings.json");
    });

    after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const permissionCases = [
      {
        name: "derives server names when there is no mcpServers block at all",
        settings: { permissions: { allow: [
          "mcp__sparkle-orchestrator__*",
          "mcp__sparkle-control__*",
          "mcp__claude-in-chrome__navigate",
        ] } },
        expected: ["claude-in-chrome", "sparkle-control", "sparkle-orchestrator"],
      },
      {
        name: "merges an explicit mcpServers block with the derived names",
        settings: { mcpServers: { linear: {} }, permissions: { allow: ["mcp__sparkle-control__*"] } },
        expected: ["linear", "sparkle-control"],
      },
      {
        name: "deduplicates a server that appears in both places",
        settings: { mcpServers: { "sparkle-control": {} }, permissions: { allow: ["mcp__sparkle-control__*"] } },
        expected: ["sparkle-control"],
      },
      {
        name: "ignores permission entries that are not MCP tools",
        settings: { permissions: { allow: ["Bash(npm run test:*)", "Read", "mcp__linear__*"] } },
        expected: ["linear"],
      },
      {
        name: "never leaks the tool name, only the server",
        settings: { permissions: { allow: ["mcp__linear__create_issue_with_secret_token"] } },
        expected: ["linear"],
      },
    ];

    for (const { name, settings, expected } of permissionCases) {
      it(name, () => {
        fs.writeFileSync(settingsPath, JSON.stringify(settings));
        assert.deepEqual(collectMcpServers(settingsPath), expected);
      });
    }

    // Kept separate: these assert on unreadable input rather than on parsing.
    it("returns [] for a missing or malformed settings file", () => {
      assert.deepEqual(collectMcpServers(path.join(tmpDir, "gone.json")), []);
      fs.writeFileSync(settingsPath, "{ not json");
      assert.deepEqual(collectMcpServers(settingsPath), []);
    });
  });

  describe("collectHooks", () => {
    it("returns events array and count", () => {
      const result = collectHooks();
      assert.ok(Array.isArray(result.events));
      assert.equal(typeof result.count, "number");
    });
  });

  describe("collectClaudeMdStats", () => {
    it("returns global_loc and project_count", () => {
      const result = collectClaudeMdStats();
      assert.equal(typeof result.global_loc, "number");
      assert.equal(typeof result.project_count, "number");
    });

    it("never includes file content", () => {
      const result = collectClaudeMdStats();
      const serialized = JSON.stringify(result);
      // Only numbers, no actual CLAUDE.md content
      assert.ok(!serialized.includes("NEVER"));
      assert.ok(!serialized.includes("git"));
    });
  });

  describe("collectEnvironment", () => {
    it("reports the shell as a bare name, not the full path", () => {
      const origShell = process.env.SHELL;
      process.env.SHELL = "/usr/bin/fish";
      try {
        assert.equal(collectEnvironment().shell, "fish");
      } finally {
        if (origShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = origShell;
      }
    });

    it("never includes HOME or sensitive env vars", () => {
      const result = collectEnvironment();
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(os.homedir()));
      assert.ok(!serialized.includes("API_KEY"));
    });

    it("falls back to COMSPEC for shell when SHELL is unset (Windows)", () => {
      const origShell = process.env.SHELL;
      const origComspec = process.env.COMSPEC;
      delete process.env.SHELL;
      process.env.COMSPEC = "cmd.exe"; // separator-free so basename is host-independent
      try {
        assert.equal(collectEnvironment().shell, "cmd.exe");
      } finally {
        if (origShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = origShell;
        if (origComspec === undefined) delete process.env.COMSPEC;
        else process.env.COMSPEC = origComspec;
      }
    });
  });
});
