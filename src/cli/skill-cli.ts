/**
 * Skill CLI · #85
 *   codeclaw skill list           列出 builtin + user 已装 skill
 *   codeclaw skill install <path>  从本地路径装 skill 到 ~/.codeclaw/skills/<name>/
 *   codeclaw skill remove <name>   卸载 user skill（builtin 不可卸）
 *
 * 不做：远程 git/npm install（留 P2）。本地路径 = 含 manifest.yaml 的目录。
 */

import { existsSync, mkdirSync, readFileSync, statSync, cpSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { validateManifest, defaultUserSkillsDir } from "../skills/loader";
import { createSkillRegistryFromDisk } from "../skills/registry";

const BUILTIN_NAMES = new Set(["review", "explain", "patch"]);

export function runSkillSubcommand(args: string[]): number {
  const [op, ...rest] = args;
  switch (op) {
    case "list":
    case undefined:
      return runList();
    case "install":
      return runInstall(rest[0]);
    case "remove":
    case "uninstall":
      return runRemove(rest[0]);
    case "--help":
    case "-h":
    case "help":
      printHelp();
      return 0;
    default:
      console.error(`Unknown skill subcommand: ${op}`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  console.log(`
codeclaw skill <subcommand>

Subcommands:
  list                       List installed skills (builtin + user).
  install <local-path>       Install skill from a local directory containing manifest.yaml.
  remove <skill-name>        Remove a user skill (builtin cannot be removed).

Examples:
  codeclaw skill list
  codeclaw skill install ./my-skills/lint-fix
  codeclaw skill remove lint-fix
`);
}

function runList(): number {
  const reg = createSkillRegistryFromDisk();
  const list = reg.list();
  console.log(`Installed skills (${list.length}):\n`);
  for (const skill of list) {
    const tag = skill.source === "builtin" ? "[builtin]" : skill.source === "signed" ? "[signed]" : "[user]";
    console.log(`  ${tag.padEnd(10)} ${skill.name.padEnd(20)} ${skill.description}`);
    if (skill.commands?.length) {
      const cmds = skill.commands.map((c) => c.name).join(", ");
      console.log(`             slash: ${cmds}`);
    }
  }
  const errs = reg.getLoadErrors();
  if (errs.length) {
    console.log(`\nLoad errors (${errs.length}):`);
    for (const e of errs) console.log(`  - ${e.path}: ${e.reason}`);
  }
  return 0;
}

function runInstall(srcPath: string | undefined): number {
  if (!srcPath) {
    console.error("Usage: codeclaw skill install <local-path>");
    return 2;
  }
  const absSrc = path.resolve(srcPath);
  if (!existsSync(absSrc) || !statSync(absSrc).isDirectory()) {
    console.error(`Source must be an existing directory: ${absSrc}`);
    return 2;
  }
  const manifestPath = path.join(absSrc, "manifest.yaml");
  if (!existsSync(manifestPath)) {
    console.error(`Missing manifest.yaml in ${absSrc}`);
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(`yaml parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const validation = validateManifest(parsed, BUILTIN_NAMES);
  if (!validation.ok) {
    console.error(`Manifest validation failed: ${validation.reason}`);
    return 2;
  }

  const target = path.join(defaultUserSkillsDir(), validation.manifest.name);
  if (existsSync(target)) {
    console.error(`Skill "${validation.manifest.name}" already installed at ${target}`);
    console.error(`Remove it first: codeclaw skill remove ${validation.manifest.name}`);
    return 2;
  }

  mkdirSync(defaultUserSkillsDir(), { recursive: true });
  cpSync(absSrc, target, { recursive: true });
  console.log(`✓ Installed "${validation.manifest.name}" → ${target}`);
  if (validation.manifest.signature) {
    console.log(
      `  source: signed (algo=${validation.manifest.signature.algo})\n` +
        `  Note: signature verification is P2 placeholder; trust the source.`
    );
  } else {
    console.log("  source: user (unsigned)");
  }
  return 0;
}

function runRemove(name: string | undefined): number {
  if (!name) {
    console.error("Usage: codeclaw skill remove <skill-name>");
    return 2;
  }
  if (BUILTIN_NAMES.has(name.toLowerCase())) {
    console.error(`Cannot remove builtin skill: ${name}`);
    return 2;
  }
  const target = path.join(defaultUserSkillsDir(), name);
  if (!existsSync(target)) {
    console.error(`Skill not found: ${target}`);
    return 2;
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`✓ Removed "${name}" from ${target}`);
  return 0;
}

/** 测试用：列出已装 skills 不依赖 console.log */
export function listInstalledSkillNames(skillsDir: string = defaultUserSkillsDir()): string[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir).filter((n) => {
    const sub = path.join(skillsDir, n);
    return existsSync(path.join(sub, "manifest.yaml"));
  });
}
