import { Command } from "commander";
import { post } from "./post.js";
import { pause, resume } from "./pause.js";
import { status } from "./status.js";
import { register, unregister, list } from "./register.js";

// Hook and MCP entrypoints — checked before commander parses argv.
const hookArg = process.argv[2];
if (hookArg === "--hook-post-tool-use") {
  import("../hooks/post-tool-use.js").catch(() => process.exit(0));
} else if (hookArg === "--hook-user-prompt-submit") {
  import("../hooks/user-prompt-submit.js").catch(() => process.exit(0));
} else if (hookArg === "--mcp") {
  import("../mcp/server.js").catch((err) => {
    process.stderr.write(`MCP server error: ${err}\n`);
    process.exit(1);
  });
} else {

const program = new Command();

program
  .name("claude-report")
  .description("Automatic dev status updates from Claude Code to Slack")
  .version("0.1.0");

program
  .command("register [path]")
  .description("Register a directory for status logging (default: current dir)")
  .action(register);

program
  .command("unregister [path]")
  .description("Unregister a directory from status logging")
  .action(unregister);

program
  .command("list")
  .description("List all registered directories")
  .action(list);

program
  .command("post <message>")
  .description("Manually post a status update")
  .option("-t, --type <type>", "Update type: status|blocker|completion|pivot|push", "status")
  .action(post);

program
  .command("pause")
  .description("Pause status posting for current project")
  .action(pause);

program
  .command("resume")
  .description("Resume status posting")
  .action(resume);

program
  .command("status")
  .description("Show current session state and recent posts")
  .action(status);

program.parse();

} // end else (non-hook/mcp mode)
