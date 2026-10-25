import * as fs from "node:fs";
import * as path from "node:path";
import { builtinModules } from "node:module";
import { computeContentHash } from "../ingestion/hasher.ts";
import { readSourceFile } from "../resources/source-files.ts";
import type { ImportResolution, ResolutionTarget } from "../../types/index.ts";

export const RESOLVER_REVISION = "1";
const GO_STDLIB = new Set("archive bufio builtin bytes cmp compress container context crypto database debug embed encoding errors expvar flag fmt go hash html image index io iter log maps math mime net os path plugin reflect regexp runtime slices sort strconv strings structs sync syscall testing text time unicode unique unsafe".split(" "));

const PYTHON_STDLIB = new Set("abc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg cProfile crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nntplib numbers operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 ssl stat statistics string stringprep struct subprocess sunau symbol symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios test textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo".split(" "));

const PYTHON_DIST_TO_MODULE_MAP: Record<string, string[]> = {
  pillow: ["pil"],
  pyyaml: ["yaml"],
  python_dotenv: ["dotenv"],
  scikit_learn: ["sklearn"],
  beautifulsoup4: ["bs4"],
  opencv_python: ["cv2"],
  protobuf: ["google"],
  typing_extensions: ["typing_extensions"],
};

const PHP_STDLIB = new Set([
  "stdClass", "Exception", "ErrorException", "Error", "TypeError", "ValueError", "ArgumentCountError",
  "ArithmeticError", "DivisionByZeroError", "ParseError", "AssertionError", "DateTime", "DateTimeImmutable",
  "DateTimeZone", "DateInterval", "DatePeriod", "PDO", "PDOStatement", "PDOException", "Closure", "Generator",
  "Fiber", "Throwable", "Stringable", "Countable", "Iterator", "IteratorAggregate", "Traversable", "ArrayAccess",
  "Serializable", "SplFileInfo", "SplFileObject", "SplFixedArray", "SplDoublyLinkedList", "SplQueue", "SplStack",
  "SplHeap", "SplMinHeap", "SplMaxHeap", "SplPriorityQueue", "SplObserver", "SplSubject", "Reflection",
  "ReflectionClass", "ReflectionMethod", "ReflectionFunction", "ReflectionProperty", "ReflectionParameter",
  "ReflectionType", "ReflectionNamedType", "ReflectionUnionType", "ReflectionIntersectionType", "ReflectionAttribute",
  "ReflectionEnum", "ReflectionEnumUnitCase", "ReflectionEnumBackedCase", "JsonException", "DomainException",
  "InvalidArgumentException", "LengthException", "LogicException", "OutOfBoundsException", "OutOfRangeException",
  "OverflowException", "RangeException", "RuntimeException", "UnderflowException", "UnexpectedValueException",
  "BadFunctionCallException", "BadMethodCallException", "Attribute"
]);

/** Static, workspace-contained resolution. No manifest scripts, downloads or retained cache. */
export class ImportResolver {
  private root: string;
  constructor(root: string, private packageRoots: string[] = []) { this.root = path.resolve(root); }

  public resolve(target: string, sourceFile: string): ImportResolution {
    const manifests: Record<string, string> = {};
    const result: ImportResolution = {
      status: "unresolved", targets: [], reason: "target_not_found", coverage: "partial",
      resolver_revision: RESOLVER_REVISION, config_revision: "", source: { file: sourceFile, target },
    };
    const finish = (status: ImportResolution["status"], reason: string, targets: ResolutionTarget[] = []) => ({
      ...result, status, reason, targets,
      config_revision: computeContentHash(JSON.stringify({ root: this.root, revision: RESOLVER_REVISION, manifests })),
    });
    const read = (file: string): string | undefined => {
      this.assertContained(file);
      if (!fs.existsSync(file)) { manifests[path.relative(this.root, file)] = "missing"; return undefined; }
      const text = readSourceFile(file); manifests[path.relative(this.root, file)] = computeContentHash(text); return text;
    };
    const json = (file: string): any => {
      const raw = read(file); if (raw === undefined) return {};
      const clean = raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : " ")
        .replace(/"(?:\\.|[^"\\])*"|,\s*[}\]]/g, token => token.startsWith('"') ? token : token.slice(1));
      const parsed = JSON.parse(clean);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("malformed_manifest");
      return parsed;
    };
    const filesAt = (base: string, extensions: string[]): string[] => {
      this.assertContained(base);
      const candidates = [base, ...extensions.map(ext => base + ext), ...extensions.map(ext => path.join(base, "index" + ext))];
      return [...new Set(candidates.filter(file => {
        this.assertContained(file);
        return fs.existsSync(file) && fs.statSync(file).isFile();
      }).map(file => path.relative(this.root, file).replace(/\\/g, "/")))];
    };
    const resolvedFiles = (files: string[], reason: string) => {
      const unique = [...new Set(files)].sort();
      return finish(unique.length === 1 ? "resolved" : unique.length > 1 ? "ambiguous" : "unresolved", reason,
        unique.map(file => ({ kind: "file", files: [file] })));
    };
    try {
      if (target.startsWith("dynamic:")) return finish("unresolved", "dynamic_target");
      const source = path.resolve(this.root, sourceFile); this.assertContained(source);
      const ext = path.extname(source).toLowerCase();
      if (ext === ".go") {
        let dir = path.dirname(source), modDir: string | undefined, mod = "";
        while (true) {
          if (read(path.join(dir, "go.work")) !== undefined) return finish("unsupported", "go_work_not_supported");
          const text = read(path.join(dir, "go.mod"));
          if (text !== undefined && !modDir) { modDir = dir; mod = text; }
          if (dir === this.root) break;
          dir = path.dirname(dir);
        }
        if (!modDir) return finish("unsupported", "go_mod_missing");
        if (/^\s*replace\b/m.test(mod)) return finish("unsupported", "go_replace_not_supported");
        const moduleName = mod.match(/^\s*module\s+([^\s]+)\s*$/m)?.[1]?.replace(/^"|"$/g, "");
        if (!moduleName) return finish("unsupported", "malformed_go_mod");
        if (target === moduleName || target.startsWith(moduleName + "/")) {
          const packageDir = path.resolve(modDir, target.slice(moduleName.length).replace(/^\//, "")); this.assertContained(packageDir);
          let parent = packageDir;
          while (parent !== modDir) {
            if (!parent.startsWith(modDir + path.sep)) return finish("unsupported", "outside_module");
            if (read(path.join(parent, "go.mod")) !== undefined) return finish("unsupported", "nested_go_mod");
            parent = path.dirname(parent);
          }
          if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) return finish("unresolved", "go_package_missing");
          const names = fs.readdirSync(packageDir).filter(name => name.endsWith(".go") && !name.endsWith("_test.go")).sort();
          const packageFiles: string[] = [];
          for (const name of names) {
            const file = path.join(packageDir, name); this.assertContained(file);
            const content = readSourceFile(file);
            if (/^\s*\/\/\s*(?:go:build|\+build)\b/m.test(content) || /_(?:linux|windows|darwin|freebsd|amd64|arm64|386|arm)\.go$/.test(name)) result.coverage = "conditional";
            packageFiles.push(path.relative(this.root, file).replace(/\\/g, "/"));
          }
          return packageFiles.length ? finish("resolved", "go_module_package", [{ kind: "package", files: packageFiles }]) : finish("unresolved", "go_package_empty");
        }
        if (GO_STDLIB.has(target.split("/")[0]!)) return finish("external", "go_standard_library");
        const requirements = [...mod.matchAll(/^\s*(?:require\s+)?([A-Za-z0-9._~/-]+)\s+v[^\s]+/gm)].map(m => m[1]!);
        if (requirements.some(name => target === name || target.startsWith(name + "/"))) return finish("external", "go_required_module");
        return finish("unresolved", "go_module_not_declared");
      }
      if (ext === ".php") {
        const normTarget = target.replace(/^\\/, "");
        if (
          PHP_STDLIB.has(normTarget) ||
          normTarget.startsWith("Attribute") ||
          normTarget.startsWith("ReturnTypeWillChange")
        ) {
          return finish("external", "php_standard_library");
        }

        const composer = json(path.join(this.root, "composer.json"));
        const rules = { ...(composer.autoload?.["psr-4"] ?? {}), ...(composer["autoload-dev"]?.["psr-4"] ?? {}) };
        const matches = Object.keys(rules)
          .filter((prefix) => normTarget.startsWith(prefix.replace(/^\\/, "")))
          .sort((a, b) => b.length - a.length);

        if (matches.length > 0) {
          const prefix = matches[0]!;
          const cleanPrefix = prefix.replace(/^\\/, "");
          const dirs = Array.isArray(rules[prefix]) ? rules[prefix] : [rules[prefix]];
          if (!dirs.every((d: unknown) => typeof d === "string")) return finish("unsupported", "malformed_psr4");

          const relativePath = normTarget.slice(cleanPrefix.length).replace(/\\/g, "/");
          const candidateFiles: string[] = [];
          for (const dir of dirs) {
            const absBase = path.resolve(this.root, dir, relativePath);
            this.assertContained(absBase);
            candidateFiles.push(...filesAt(absBase, [".php"]));
          }

          if (candidateFiles.length === 0) {
            return finish("unresolved", "file_not_found");
          }
          return resolvedFiles(candidateFiles, "composer_psr4");
        }

        // Check declared composer dependencies
        const requirements = { ...(composer.require ?? {}), ...(composer["require-dev"] ?? {}) };
        const topNamespace = normTarget.split("\\")[0]!.toLowerCase();
        for (const reqPackage of Object.keys(requirements)) {
          const [vendor, pkg] = reqPackage.toLowerCase().split("/");
          if (
            vendor === topNamespace ||
            pkg === topNamespace ||
            (vendor === "laravel" && topNamespace === "illuminate") ||
            (vendor === "symfony" && topNamespace === "symfony") ||
            (vendor === "guzzlehttp" && topNamespace === "guzzlehttp")
          ) {
            return finish("external", "composer_required_package");
          }
        }

        if (
          normTarget.startsWith("Illuminate\\") ||
          normTarget.startsWith("Symfony\\") ||
          normTarget.startsWith("Psr\\") ||
          normTarget.startsWith("Composer\\")
        ) {
          return finish("external", "php_framework_namespace");
        }

        return finish("unresolved", "php_namespace_not_mapped");
      }
      if (ext === ".py") {
        if (target.startsWith(".")) {
          const dotsMatch = target.match(/^\.+/);
          const dotCount = dotsMatch ? dotsMatch[0].length : 0;
          const remainder = target.slice(dotCount);
          let baseDir = path.dirname(source);
          for (let i = 1; i < dotCount; i++) {
            baseDir = path.dirname(baseDir);
          }
          this.assertContained(baseDir);
          const fsSubpath = remainder ? remainder.split(".").join(path.sep) : "";
          const targetDirOrFile = fsSubpath ? path.resolve(baseDir, fsSubpath) : baseDir;
          this.assertContained(targetDirOrFile);

          const candidates: string[] = [];
          if (fsSubpath) {
            const pyFile = targetDirOrFile + ".py";
            if (fs.existsSync(pyFile) && fs.statSync(pyFile).isFile()) {
              candidates.push(path.relative(this.root, pyFile).replace(/\\/g, "/"));
            }
          }
          const initFile = path.join(targetDirOrFile, "__init__.py");
          if (fs.existsSync(initFile) && fs.statSync(initFile).isFile()) {
            candidates.push(path.relative(this.root, initFile).replace(/\\/g, "/"));
          }
          return resolvedFiles(candidates, "python_relative_module");
        }

        const parts = target.split(".");
        const topPackage = parts[0]!;
        const fsSubpath = parts.join(path.sep);

        const searchRoots: string[] = [];
        const srcDir = path.resolve(this.root, "src");
        if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
          searchRoots.push(srcDir);
        }
        searchRoots.push(this.root);
        const callerDir = path.dirname(source);
        if (callerDir !== this.root && callerDir !== srcDir) {
          searchRoots.push(callerDir);
        }
        for (const pkgRoot of this.packageRoots) {
          const abs = path.resolve(this.root, pkgRoot);
          if (!searchRoots.includes(abs) && fs.existsSync(abs)) {
            searchRoots.push(abs);
          }
        }

        const localCandidates: string[] = [];
        for (const sRoot of searchRoots) {
          const candidateFile = path.resolve(sRoot, fsSubpath + ".py");
          if (candidateFile.startsWith(this.root + path.sep) && fs.existsSync(candidateFile) && fs.statSync(candidateFile).isFile()) {
            localCandidates.push(path.relative(this.root, candidateFile).replace(/\\/g, "/"));
          }
          const candidateInit = path.resolve(sRoot, fsSubpath, "__init__.py");
          if (candidateInit.startsWith(this.root + path.sep) && fs.existsSync(candidateInit) && fs.statSync(candidateInit).isFile()) {
            localCandidates.push(path.relative(this.root, candidateInit).replace(/\\/g, "/"));
          }
        }

        const unique = [...new Set(localCandidates)].sort();
        if (unique.length > 0) {
          return finish(
            unique.length === 1 ? "resolved" : "ambiguous",
            unique.length === 1 ? "python_local_module" : "multiple_python_candidates",
            unique.map(file => ({ kind: "file", files: [file] }))
          );
        }

        if (PYTHON_STDLIB.has(topPackage)) {
          return finish("external", "python_standard_library");
        }

        const declaredPackages = new Set<string>();
        const reqText = read(path.join(this.root, "requirements.txt"));
        if (reqText) {
          for (const rawLine of reqText.split(/\r?\n/)) {
            const line = rawLine.replace(/#.*$/, "").trim();
            if (!line || line.startsWith("-")) continue;
            const match = line.match(/^([A-Za-z0-9_.-]+)/);
            if (match) declaredPackages.add(match[1].toLowerCase().replace(/[-_.]/g, "_"));
          }
        }
        const pyprojectText = read(path.join(this.root, "pyproject.toml"));
        if (pyprojectText) {
          for (const rawLine of pyprojectText.split(/\r?\n/)) {
            const line = rawLine.replace(/#.*$/, "").trim();
            const matchArray = line.match(/^["']([A-Za-z0-9_.-]+)(?:[><=~!^;].*)?["']/);
            if (matchArray) {
              declaredPackages.add(matchArray[1].toLowerCase().replace(/[-_.]/g, "_"));
              continue;
            }
            const matchKey = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(?:\{|"[^"]*"|'[^']*'|\d)/);
            if (matchKey && !["python", "version", "name", "description"].includes(matchKey[1].toLowerCase())) {
              declaredPackages.add(matchKey[1].toLowerCase().replace(/[-_.]/g, "_"));
            }
          }
        }
        const pipfileText = read(path.join(this.root, "Pipfile"));
        if (pipfileText) {
          for (const rawLine of pipfileText.split(/\r?\n/)) {
            const line = rawLine.replace(/#.*$/, "").trim();
            const match = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
            if (match) declaredPackages.add(match[1].toLowerCase().replace(/[-_.]/g, "_"));
          }
        }

        const normalizedTop = topPackage.toLowerCase().replace(/[-_.]/g, "_");
        const isDeclared = declaredPackages.has(normalizedTop) ||
          Object.entries(PYTHON_DIST_TO_MODULE_MAP).some(([dist, mods]) => declaredPackages.has(dist) && mods.includes(normalizedTop));

        if (isDeclared) {
          return finish("external", "python_manifest_dependency");
        }

        return finish("unresolved", "python_module_not_declared");
      }
      if (!/\.(?:[cm]?[jt]sx?|vue|astro|svelte)$/.test(ext)) return finish("unsupported", "language_resolver_unavailable");
      const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".json"];
      if (target.startsWith(".") || path.isAbsolute(target)) return resolvedFiles(filesAt(path.resolve(path.dirname(source), target), extensions), "relative_path");
      if (builtinModules.includes(target) || target.startsWith("node:") && builtinModules.includes(target.slice(5)) || target === "bun" || target.startsWith("bun:")) return finish("external", "runtime_builtin");
      const tsconfig = json(path.join(this.root, "tsconfig.json"));
      if (tsconfig.extends) return finish("unsupported", "tsconfig_extends_not_supported");
      const options = tsconfig.compilerOptions ?? {};
      const aliases = options.paths ?? {};
      const matching = Object.keys(aliases).filter(key => key.endsWith("*") ? target.startsWith(key.slice(0,-1)) : target === key).sort((a,b)=>b.length-a.length);
      if (matching.length) {
        const key = matching[0]!; const values = aliases[key];
        if (!Array.isArray(values) || !values.every(v=>typeof v === "string")) return finish("unsupported", "malformed_ts_paths");
        return resolvedFiles(values.flatMap((value: string) => filesAt(path.resolve(this.root, options.baseUrl ?? ".", value.replace("*", key.endsWith("*") ? target.slice(key.length-1) : "")),extensions)), "tsconfig_paths");
      }
      // Repository-root paths and the existing @/ convention are explicit local candidates.
      const local = target.startsWith("@/") ? target.replace(/^@\//,"src/") : target;
      const localFiles = filesAt(path.resolve(this.root,local),extensions);
      if (localFiles.length) return resolvedFiles(localFiles,"workspace_path");
      const pkg = json(path.join(this.root,"package.json"));
      const workspacePatterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
      const roots = [...this.packageRoots];
      for (const pattern of workspacePatterns) {
        if (typeof pattern !== "string") return finish("unsupported","malformed_workspace_pattern");
        if (pattern.endsWith("/*")) {
          const parent = path.resolve(this.root,pattern.slice(0,-2)); this.assertContained(parent);
          if (fs.existsSync(parent)) roots.push(...fs.readdirSync(parent,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>path.relative(this.root,path.join(parent,entry.name))));
        } else if (!pattern.includes("*")) roots.push(pattern);
        else return finish("unsupported","workspace_glob_not_supported");
      }
      const workspaceFiles: string[] = [];
      for (const directory of [...new Set(roots)]) {
        const workspace = json(path.resolve(this.root,directory,"package.json"));
        if (typeof workspace.name !== "string" || !(target === workspace.name || target.startsWith(workspace.name + "/"))) continue;
        const subpath = target.slice(workspace.name.length).replace(/^\//, "");
        const exported = typeof workspace.exports === "string" ? workspace.exports : workspace.exports?.["."];
        if (!subpath && exported && typeof exported !== "string") return finish("unsupported","conditional_package_exports");
        const entry = subpath || exported || workspace.module || workspace.main || "index";
        if (typeof entry !== "string") return finish("unsupported","package_entry_not_literal");
        workspaceFiles.push(...filesAt(path.resolve(this.root,directory,entry),extensions));
      }
      if (workspaceFiles.length) return resolvedFiles(workspaceFiles,"workspace_package");
      const name = target.startsWith("@") ? target.split("/").slice(0,2).join("/") : target.split("/")[0]!;
      if ([pkg.dependencies,pkg.devDependencies,pkg.peerDependencies,pkg.optionalDependencies].some(deps => deps && Object.hasOwn(deps,name))) return finish("external","package_manifest_dependency");
      return finish("unresolved", "package_not_declared");
    } catch (error) {
      return finish("unsupported", error instanceof Error && error.message.includes("outside_workspace") ? "outside_workspace" : `manifest_or_source_error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private assertContained(file: string): void {
    const contained = (candidate: string, root: string) => candidate === root || candidate.startsWith(root + path.sep);
    if (!contained(path.resolve(file), this.root)) throw new Error("outside_workspace");
    let existing = file;
    while (!fs.existsSync(existing) && existing !== this.root) existing = path.dirname(existing);
    if (fs.existsSync(existing) && !contained(fs.realpathSync(existing), fs.realpathSync(this.root))) throw new Error("outside_workspace");
  }
}
