import { defineConfig } from "tsup";

export default defineConfig([
  // CLI entrypoint — needs shebang for `bin`
  {
    entry: { "cli/index": "src/cli/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  // Library and MCP server — no shebang, external deps
  {
    entry: {
      "core/index": "src/core/index.ts",
      "mcp/server": "src/mcp/server.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: false, // Don't clean — CLI build already cleaned
    target: "node20",
    splitting: false,
  },
  // Hooks — bundle ALL deps (hooks run from arbitrary cwd, can't rely on node_modules)
  {
    entry: {
      "hooks/post-tool-use": "src/hooks/post-tool-use.ts",
      "hooks/user-prompt-submit": "src/hooks/user-prompt-submit.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "node20",
    splitting: false,
    noExternal: [],
  },
]);
