import { Command } from "commander";
import { post } from "./post.js";
import { pause, resume } from "./pause.js";
import { status } from "./status.js";
import { enable, disable, users } from "./register.js";

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
  .command("enable [user]")
  .description("Enable reporting for a git user (default: current git user)")
  .action(enable);

program
  .command("disable [user]")
  .description("Disable reporting for a git user")
  .action(disable);

program
  .command("users")
  .description("List enabled users and current git identity")
  .action(users);

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
