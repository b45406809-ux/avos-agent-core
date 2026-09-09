import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export const CLAUDE_TOOLS = [
  {
    type: "function",
    function: {
      name: "glob_files",
      description: "Search workspace file tree by glob pattern (e.g. '*.ts', 'SpaceDO.*', 'src/**/*.sql').",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "Fast ripgrep (rg) regex search across code. Returns matching files and exact line numbers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string", description: "Subfolder, default '.'" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file_slice",
      description: "Read an exact line slice of a file. Use this before editing.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" }
        },
        required: ["filePath", "startLine", "endLine"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "str_replace_editor",
      description: "Surgically search and replace exact lines in a file. Must match exact whitespace.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          oldStr: { type: "string" },
          newStr: { type: "string" }
        },
        required: ["filePath", "oldStr", "newStr"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_new_file",
      description: "Create a brand new file.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          content: { type: "string" }
        },
        required: ["filePath", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bash_exec",
      description: "Execute a shell command in the Linux runner (e.g., 'npm test', 'tsc --noEmit', 'git diff').",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "finish_goal",
      description: "Call this ONLY when the goal is verified via tests/compiler diagnostics.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"]
      }
    }
  }
];

export function executeTool(name, args, workspaceDir = "./workspace") {
  try {
    if (name === "glob_files") {
      const out = execSync(`find . -not -path '*/.*' -not -path '*/node_modules/*' -name "${args.pattern}" | head -n 40`, {
        cwd: workspaceDir,
        encoding: "utf-8"
      });
      return out.trim() || "No files found.";
    }

    if (name === "grep_search") {
      const target = args.path || ".";
      const out = execSync(`rg -n -C 2 -m 20 --glob '!node_modules' "${args.query}" ${target} || true`, {
        cwd: workspaceDir,
        encoding: "utf-8"
      });
      return out.trim() || "No matches found.";
    }

    if (name === "read_file_slice") {
      const full = path.resolve(workspaceDir, args.filePath);
      if (!fs.existsSync(full)) return `Error: ${args.filePath} does not exist.`;
      const lines = fs.readFileSync(full, "utf-8").split("\n");
      const start = Math.max(0, args.startLine - 1);
      const end = Math.min(lines.length, args.endLine);
      return lines.slice(start, end).map((l, i) => `${start + i + 1} | ${l}`).join("\n");
    }

    if (name === "str_replace_editor") {
      const full = path.resolve(workspaceDir, args.filePath);
      if (!fs.existsSync(full)) return `Error: ${args.filePath} does not exist.`;
      let content = fs.readFileSync(full, "utf-8");
      if (!content.includes(args.oldStr)) {
        return `Error: oldStr not found in ${args.filePath}. Use read_file_slice to inspect exact lines and indentation.`;
      }
      content = content.replace(args.oldStr, args.newStr);
      fs.writeFileSync(full, content, "utf-8");
      return `Successfully modified ${args.filePath}`;
    }

    if (name === "write_new_file") {
      const full = path.resolve(workspaceDir, args.filePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, args.content, "utf-8");
      return `Created ${args.filePath}`;
    }

    if (name === "bash_exec") {
      const out = execSync(args.command, {
        cwd: workspaceDir,
        encoding: "utf-8",
        timeout: 90000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      return truncateLogs(out || "Command succeeded with no output.");
    }

    if (name === "finish_goal") {
      return "GOAL_ACCOMPLISHED";
    }
  } catch (err) {
    const combined = (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + err.message;
    return `Exit error:\n${truncateLogs(combined)}`;
  }
}

function truncateLogs(str, maxLines = 35) {
  const lines = str.split("\n");
  if (lines.length <= maxLines) return str;
  return `${lines.slice(0, 10).join("\n")}\n\n... [TRUNCATED ${lines.length - 35} LINES] ...\n\n${lines.slice(-25).join("\n")}`;
        }
