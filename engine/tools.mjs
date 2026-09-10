import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { generateProjectMap, getFileOutline } from "./indexer.mjs";

// ============================================================================
// 1. Tool Schemas (OpenAI / Claude Tool Definition Format)
// ============================================================================
export const CLAUDE_TOOLS = [
  {
    type: "function",
    function: {
      name: "glob_files",
      description: "Search workspace file tree by name or glob pattern (e.g. '*.rs', 'auth.*', 'src/**/*.ts'). Excludes dependencies and build artifacts.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob filename pattern or substring to match"
          }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "Fast ripgrep (rg) regex search across files. Returns matching file paths, line numbers, and context snippets.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Regex pattern or keyword to search for"
          },
          path: {
            type: "string",
            description: "Subdirectory or file to limit search to (defaults to '.')"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_project_map",
      description: "Generate a structural Tree-sitter map of classes, functions, and interfaces across a directory. Ideal for initial orientation without reading full implementations.",
      parameters: {
        type: "object",
        properties: {
          subpath: {
            type: "string",
            description: "Directory path relative to workspace root (defaults to '.')"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_file_outline",
      description: "Get the structural Tree-sitter outline (types, functions, traits, method signatures with line numbers, without bodies) for a specific file.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Relative path to target file (e.g. 'src/btree/pager.rs')"
          }
        },
        required: ["filePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file_slice",
      description: "Read a specific 1-based line slice from a file. Always inspect the exact lines and whitespace before modifying a file.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Relative path to the file"
          },
          offset: {
            type: "number",
            description: "Starting line number (1-based, defaults to 1)"
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read (defaults to 150)"
          }
        },
        required: ["filePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Surgically replace ONE unique occurrence of 'oldStr' with 'newStr'. Must match exact indentation and line breaks. Include 3-5 lines of context to ensure uniqueness.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Relative path to the file to edit"
          },
          oldStr: {
            type: "string",
            description: "Exact existing code snippet to find (must be unique in the file)"
          },
          newStr: {
            type: "string",
            description: "Replacement code snippet"
          }
        },
        required: ["filePath", "oldStr", "newStr"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_new_file",
      description: "Create a brand new file or completely overwrite an existing file. Automatically creates any missing parent directories.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Relative path to the file"
          },
          content: {
            type: "string",
            description: "Full content to write"
          }
        },
        required: ["filePath", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bash_exec",
      description: "Execute a shell command inside the workspace directory (e.g., 'cargo test', 'npm test', 'git diff', 'tsc --noEmit').",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command line to run"
          },
          timeoutMs: {
            type: "number",
            description: "Optional timeout in milliseconds (defaults to 90000, max 180000)"
          }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "finish_goal",
      description: "Signal that the assigned unit of work is completed and verified against the test oracle.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Concise summary of changes made and verification results"
          }
        },
        required: ["summary"]
      }
    }
  }
];

// ============================================================================
// 2. Security & Truncation Helpers
// ============================================================================

// Security check against high-risk or interactive commands (matching OpenCode's policy)
const BANNED_COMMANDS = new Set([
  "alias", "curl", "wget", "nc", "telnet", "lynx", "w3m",
  "ssh", "sftp", "rm -rf /", "rm -rf /*"
]);

/**
 * Truncates output to avoid blowing the context window on noisy compiler/test dumps.
 */
function truncateLogs(output, maxLines = 45) {
  if (!output) return "Command succeeded with no output.";
  const lines = output.split("\n");
  if (lines.length <= maxLines) return output;

  const head = lines.slice(0, 18).join("\n");
  const tail = lines.slice(-22).join("\n");
  const omitted = lines.length - 40;

  return `${head}\n\n... [TRUNCATED ${omitted} LINES OF LOGS] ...\n\n${tail}`;
}

// ============================================================================
// 3. Execution Dispatcher
// ============================================================================

/**
 * Executes a tool call within the given workspace directory.
 */
export async function executeTool(name, args = {}, workspaceDir = "./workspace") {
  const resolvedWorkspace = path.resolve(workspaceDir);

  try {
    // ------------------------------------------------------------------------
    // Tool: glob_files
    // ------------------------------------------------------------------------
    if (name === "glob_files") {
      const pattern = args.pattern || "*";

      const res = spawnSync("find", [
        ".",
        "-not", "-path", "*/.*",
        "-not", "-path", "*/node_modules/*",
        "-not", "-path", "*/dist/*",
        "-not", "-path", "*/target/*",
        "-not", "-path", "*/.worktrees/*",
        "-not", "-path", "*/.agent/*",
        "-iname", pattern
      ], {
        cwd: resolvedWorkspace,
        encoding: "utf-8",
        timeout: 15000
      });

      if (res.error) return `Error during glob search: ${res.error.message}`;
      const lines = (res.stdout || "").trim().split("\n").filter(Boolean).slice(0, 50);
      return lines.length > 0 ? lines.join("\n") : `No files found matching '${pattern}'.`;
    }

    // ------------------------------------------------------------------------
    // Tool: grep_search
    // ------------------------------------------------------------------------
    if (name === "grep_search") {
      const searchTarget = args.path ? path.resolve(resolvedWorkspace, args.path) : resolvedWorkspace;
      
      const res = spawnSync("rg", [
        "-n",
        "-C", "2",
        "-m", "25",
        "--glob", "!node_modules",
        "--glob", "!.git",
        "--glob", "!target",
        "--glob", "!dist",
        "--glob", "!.worktrees",
        "--", args.query, searchTarget
      ], {
        cwd: resolvedWorkspace,
        encoding: "utf-8",
        timeout: 20000
      });

      if (res.error) {
        // Fallback to git grep if ripgrep fails
        const fallback = spawnSync("git", ["grep", "-n", "-C", "2", "-m", "25", args.query], {
          cwd: resolvedWorkspace,
          encoding: "utf-8",
          timeout: 15000
        });
        return (fallback.stdout || "").trim() || "No matches found.";
      }

      return (res.stdout || "").trim() || `No matches found for '${args.query}'.`;
    }

    // ------------------------------------------------------------------------
    // Tool: get_project_map (Tree-Sitter)
    // ------------------------------------------------------------------------
    if (name === "get_project_map") {
      return await generateProjectMap(args.subpath || ".", resolvedWorkspace, 35);
    }

    // ------------------------------------------------------------------------
    // Tool: get_file_outline (Tree-Sitter)
    // ------------------------------------------------------------------------
    if (name === "get_file_outline") {
      if (!args.filePath) return "Error: 'filePath' parameter is required.";
      return await getFileOutline(args.filePath, resolvedWorkspace);
    }

    // ------------------------------------------------------------------------
    // Tool: read_file_slice
    // ------------------------------------------------------------------------
    if (name === "read_file_slice") {
      if (!args.filePath) return "Error: 'filePath' parameter is required.";
      const fullPath = path.resolve(resolvedWorkspace, args.filePath);

      if (!fs.existsSync(fullPath)) {
        return `Error: File not found: ${args.filePath}`;
      }

      const stat = fs.statSync(fullPath);
      if (stat.size > 2 * 1024 * 1024) {
        return `Error: File '${args.filePath}' exceeds 2MB limit. Use 'get_file_outline' or 'grep_search' instead.`;
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      const offset = Math.max(1, parseInt(args.offset, 10) || 1);
      const limit = Math.max(1, Math.min(parseInt(args.limit, 10) || 150, 400));
      const startIndex = offset - 1;
      const slice = lines.slice(startIndex, startIndex + limit);

      const formatted = slice.map((line, idx) => {
        const lineNum = String(startIndex + idx + 1).padStart(6, " ");
        return `${lineNum} | ${line}`;
      }).join("\n");

      let header = `[File: ${args.filePath} (Lines ${offset} to ${Math.min(offset + limit - 1, lines.length)} of ${lines.length})]\n`;
      return header + formatted;
    }

    // ------------------------------------------------------------------------
    // Tool: edit_file (Surgical string replace with context verification)
    // ------------------------------------------------------------------------
    if (name === "edit_file") {
      const { filePath, oldStr, newStr } = args;
      if (!filePath || oldStr === undefined || newStr === undefined) {
        return "Error: Missing required parameters ('filePath', 'oldStr', 'newStr').";
      }

      const fullPath = path.resolve(resolvedWorkspace, filePath);
      if (!fs.existsSync(fullPath)) {
        return `Error: File not found: ${filePath}`;
      }

      const content = fs.readFileSync(fullPath, "utf-8");

      // Normalize line endings to avoid CRLF/LF mismatches
      const normalizedContent = content.replace(/\r\n/g, "\n");
      const normalizedOld = oldStr.replace(/\r\n/g, "\n");
      const normalizedNew = newStr.replace(/\r\n/g, "\n");

      const firstIndex = normalizedContent.indexOf(normalizedOld);
      if (firstIndex === -1) {
        return `Error: 'oldStr' not found in ${filePath}.\nMake sure exact indentation and whitespace match. Use 'read_file_slice' to inspect exact lines before editing.`;
      }

      const lastIndex = normalizedContent.lastIndexOf(normalizedOld);
      if (firstIndex !== lastIndex) {
        return `Error: 'oldStr' matched multiple locations in ${filePath}.\nInclude at least 3-5 lines of context before and after the target edit to make the search string unique.`;
      }

      const updated = normalizedContent.slice(0, firstIndex) + normalizedNew + normalizedContent.slice(firstIndex + normalizedOld.length);
      fs.writeFileSync(fullPath, updated, "utf-8");
      return `Successfully modified ${filePath}.`;
    }

    // ------------------------------------------------------------------------
    // Tool: write_new_file
    // ------------------------------------------------------------------------
    if (name === "write_new_file") {
      const { filePath, content } = args;
      if (!filePath || content === undefined) {
        return "Error: Missing required parameters ('filePath', 'content').";
      }

      const fullPath = path.resolve(resolvedWorkspace, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
      return `Successfully wrote ${filePath} (${Buffer.byteLength(content, "utf-8")} bytes).`;
    }

    // ------------------------------------------------------------------------
    // Tool: bash_exec
    // ------------------------------------------------------------------------
    if (name === "bash_exec") {
      const command = (args.command || "").trim();
      if (!command) return "Error: 'command' parameter is empty.";

      // Security check against banned base binaries
      const baseBinary = command.split(/\s+/)[0].toLowerCase();
      if (BANNED_COMMANDS.has(baseBinary) || BANNED_COMMANDS.has(command)) {
        return `Error: Command '${baseBinary}' is restricted for safety reasons.`;
      }

      const timeout = Math.min(Math.max(parseInt(args.timeoutMs, 10) || 90000, 1000), 180000);

      const res = spawnSync("bash", ["-c", command], {
        cwd: resolvedWorkspace,
        encoding: "utf-8",
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: {
          ...process.env,
          CI: "true",
          TERM: "xterm-256color"
        }
      });

      const stdout = res.stdout || "";
      const stderr = res.stderr || "";
      const combined = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim();

      if (res.error && res.error.code === "ETIMEDOUT") {
        return `Error: Command timed out after ${timeout / 1000} seconds.\n${truncateLogs(combined)}`;
      }

      if (res.status !== 0 && res.status !== null) {
        return `Command exited with status ${res.status}:\n${truncateLogs(combined || "No output.")}`;
      }

      return truncateLogs(combined || "Command completed with no output.");
    }

    // ------------------------------------------------------------------------
    // Tool: finish_goal
    // ------------------------------------------------------------------------
    if (name === "finish_goal") {
      return "GOAL_ACCOMPLISHED";
    }

    return `Error: Unknown tool name '${name}'.`;
  } catch (err) {
    return `Execution error in '${name}': ${err.message}`;
  }
            }
