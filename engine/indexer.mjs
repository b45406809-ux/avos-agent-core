import Parser from "web-tree-sitter";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// 1. WASM Parser & Grammar Loader
// ============================================================================
let parserInstance = null;
let isInitialized = false;
const loadedLanguages = new Map();

/**
 * Initializes the WASM runtime once for the process.
 */
export async function initTreeSitter() {
  if (isInitialized) return parserInstance;
  
  await Parser.init();
  parserInstance = new Parser();
  isInitialized = true;
  return parserInstance;
}

// Map file extensions to their Tree-sitter grammar names
const EXTENSION_TO_GRAMMAR = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".rs": "rust",
  ".go": "go",
  ".py": "python",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp"
};

/**
 * Resolves the path to the pre-compiled .wasm grammar binary.
 */
function resolveGrammarWasm(grammarName) {
  const candidatePaths = [
    // Standard path from tree-sitter-wasms package
    path.resolve(`./node_modules/tree-sitter-wasms/out/tree-sitter-${grammarName}.wasm`),
    path.resolve(`../node_modules/tree-sitter-wasms/out/tree-sitter-${grammarName}.wasm`),
    // VSCode wasm distribution fallback
    path.resolve(`./node_modules/@vscode/tree-sitter-wasms/wasm/tree-sitter-${grammarName}.wasm`),
    // Local vendored wasms directory
    path.resolve(`./wasms/tree-sitter-${grammarName}.wasm`)
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Dynamically loads and caches the grammar for a file extension.
 */
async function getLanguageForExtension(ext) {
  const grammarName = EXTENSION_TO_GRAMMAR[ext.toLowerCase()];
  if (!grammarName) return null;

  if (loadedLanguages.has(grammarName)) {
    return loadedLanguages.get(grammarName);
  }

  const wasmPath = resolveGrammarWasm(grammarName);
  if (!wasmPath) {
    return null;
  }

  try {
    const lang = await Parser.Language.load(wasmPath);
    loadedLanguages.set(grammarName, lang);
    return lang;
  } catch (err) {
    console.warn(`[TreeSitter] Warning: Failed to load grammar '${grammarName}': ${err.message}`);
    return null;
  }
}

// ============================================================================
// 2. Multi-Language AST Skeletonizer (Extracting Signatures, Stripping Bodies)
// ============================================================================

/**
 * AST Node visitor for TypeScript and JavaScript.
 */
function extractTypeScriptSignatures(node, lines, outlines) {
  const type = node.type;

  const tsSignatureTypes = [
    "function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration"
  ];

  if (tsSignatureTypes.includes(type)) {
    const startRow = node.startPosition.row;
    const rawLine = lines[startRow] || "";
    const indent = "  ".repeat(Math.min(Math.floor(node.startPosition.column / 2), 4));

    // Strip implementation blocks from the declaration line
    let signature = rawLine.trim();
    if (signature.includes("{")) {
      signature = signature.replace(/\{.*$/, "{ ... }");
    } else if (type === "function_declaration" || type === "method_definition") {
      signature += " { ... }";
    }

    outlines.push({
      line: startRow + 1,
      text: `${indent}${signature}`
    });
  }

  // Recurse into child nodes (e.g. methods inside a class)
  for (let i = 0; i < node.namedChildCount; i++) {
    extractTypeScriptSignatures(node.namedChild(i), lines, outlines);
  }
}

/**
 * AST Node visitor for Rust.
 */
function extractRustSignatures(node, lines, outlines) {
  const type = node.type;

  const rustSignatureTypes = [
    "function_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "impl_item",
    "type_item",
    "macro_definition"
  ];

  if (rustSignatureTypes.includes(type)) {
    const startRow = node.startPosition.row;
    const rawLine = lines[startRow] || "";
    const indent = "  ".repeat(Math.min(Math.floor(node.startPosition.column / 4), 4));

    let signature = rawLine.trim();
    if (signature.includes("{")) {
      signature = signature.replace(/\{.*$/, "{ ... }");
    } else if (signature.endsWith(";")) {
      // Traits or declarations ending with semicolon
    } else {
      signature += " { ... }";
    }

    outlines.push({
      line: startRow + 1,
      text: `${indent}${signature}`
    });
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    extractRustSignatures(node.namedChild(i), lines, outlines);
  }
}

/**
 * AST Node visitor for Go.
 */
function extractGoSignatures(node, lines, outlines) {
  const type = node.type;

  if (type === "function_declaration" || type === "method_declaration") {
    const startRow = node.startPosition.row;
    const rawLine = lines[startRow] || "";
    const signature = rawLine.trim().replace(/\{.*$/, "{ ... }");

    outlines.push({
      line: startRow + 1,
      text: signature
    });
  } else if (type === "type_declaration") {
    const startRow = node.startPosition.row;
    const rawLine = lines[startRow] || "";

    outlines.push({
      line: startRow + 1,
      text: rawLine.trim()
    });
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    extractGoSignatures(node.namedChild(i), lines, outlines);
  }
}

/**
 * AST Node visitor for Python.
 */
function extractPythonSignatures(node, lines, outlines) {
  const type = node.type;

  if (type === "function_definition" || type === "class_definition") {
    const startRow = node.startPosition.row;
    const rawLine = lines[startRow] || "";
    const indent = "  ".repeat(Math.min(Math.floor(node.startPosition.column / 4), 4));

    outlines.push({
      line: startRow + 1,
      text: `${indent}${rawLine.trim()}`
    });
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    extractPythonSignatures(node.namedChild(i), lines, outlines);
  }
}

/**
 * Fallback regex skeletonizer when Tree-sitter WASM is missing for an obscure format.
 */
function extractFallbackRegexSignatures(code) {
  const signatureRegex = /^(export\s+|pub\s+|func\s+|def\s+|class\s+|interface\s+|type\s+|struct\s+|fn\s+|impl\s+|trait\s+)/;
  const lines = code.split("\n");
  const outlines = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (signatureRegex.test(trimmed)) {
      outlines.push({
        line: i + 1,
        text: trimmed.replace(/\{.*$/, "{ ... }")
      });
    }
  }
  return outlines;
}

// ============================================================================
// 3. Public API: File Outline & Project Map Generator
// ============================================================================

/**
 * Returns a structural AST outline for a specific file with 1-based line numbers.
 */
export async function getFileOutline(filePath, workspaceDir = "./workspace") {
  const parser = await initTreeSitter();
  const absolutePath = path.resolve(workspaceDir, filePath);

  if (!fs.existsSync(absolutePath)) {
    return `Error: File not found: ${filePath}`;
  }

  const code = fs.readFileSync(absolutePath, "utf-8");
  const ext = path.extname(absolutePath);
  const lang = await getLanguageForExtension(ext);

  let rawOutlines = [];

  if (!lang) {
    // Regex fallback
    rawOutlines = extractFallbackRegexSignatures(code);
  } else {
    parser.setLanguage(lang);
    const tree = parser.parse(code);
    const lines = code.split("\n");

    switch (EXTENSION_TO_GRAMMAR[ext.toLowerCase()]) {
      case "typescript":
      case "tsx":
      case "javascript":
        extractTypeScriptSignatures(tree.rootNode, lines, rawOutlines);
        break;
      case "rust":
        extractRustSignatures(tree.rootNode, lines, rawOutlines);
        break;
      case "go":
        extractGoSignatures(tree.rootNode, lines, rawOutlines);
        break;
      case "python":
        extractPythonSignatures(tree.rootNode, lines, rawOutlines);
        break;
      default:
        rawOutlines = extractFallbackRegexSignatures(code);
    }
  }

  if (rawOutlines.length === 0) {
    return `// ${filePath}: (No top-level function/class/interface declarations detected)`;
  }

  // Format with line numbers padded to 5 characters
  return rawOutlines
    .map(o => `${String(o.line).padStart(5, " ")} | ${o.text}`)
    .join("\n");
}

/**
 * Traverses a repository directory and generates a compressed structural map.
 * Caps file count to stay strictly within LLM context budget (<10k tokens).
 */
export async function generateProjectMap(subpath = ".", workspaceDir = "./workspace", maxFiles = 40) {
  const targetRoot = path.resolve(workspaceDir, subpath);
  if (!fs.existsSync(targetRoot)) {
    return `Directory not found: ${subpath}`;
  }

  const ignoredDirectories = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    ".worktrees",
    ".agent",
    "coverage",
    "vendor",
    "__pycache__",
    ".venv",
    ".idea",
    ".vscode"
  ]);

  const candidateFiles = [];

  function walk(currentDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (EXTENSION_TO_GRAMMAR[ext.toLowerCase()]) {
          candidateFiles.push(path.relative(workspaceDir, fullPath));
        }
      }
    }
  }

  walk(targetRoot);

  // Sort files by priority: root manifests & entry points first, then shallow paths
  candidateFiles.sort((a, b) => {
    const isRootA = !a.includes("/") && !a.includes("\\");
    const isRootB = !b.includes("/") && !b.includes("\\");
    if (isRootA && !isRootB) return -1;
    if (!isRootA && isRootB) return 1;
    return a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b);
  });

  const selected = candidateFiles.slice(0, maxFiles);
  const mapSegments = [];

  for (const relFile of selected) {
    const outline = await getFileOutline(relFile, workspaceDir);
    mapSegments.push(`\n=== File: ${relFile} ===\n${outline}`);
  }

  if (candidateFiles.length > maxFiles) {
    const omitted = candidateFiles.length - maxFiles;
    mapSegments.push(`\n... [TRUNCATED ${omitted} additional source files. Query specific subsystems using get_project_map(subpath)] ...`);
  }

  return mapSegments.length > 0
    ? mapSegments.join("\n")
    : "No supported source files found in target directory.";
    }
