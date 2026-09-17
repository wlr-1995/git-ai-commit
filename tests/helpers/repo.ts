import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function makeTempDir(prefix = "gac-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${result.stderr || result.stdout}`)
  }
  return result.stdout ?? ""
}

export function initRepo(dir: string, branch?: string): string {
  git(dir, branch ? ["init", "-b", branch] : ["init"])
  git(dir, ["config", "user.name", "t"])
  git(dir, ["config", "user.email", "t@example.com"])
  return dir
}

export function writeFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, "utf8")
}

export function initRepoWithCommit(dir: string, files: Record<string, string> = { "seed.txt": "seed" }): string {
  initRepo(dir)
  for (const [name, content] of Object.entries(files)) {
    writeFile(dir, name, content)
  }
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init"])
  return dir
}

export function commitAll(dir: string, message = "init"): void {
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", message])
}

export function filesInHead(dir: string): string[] {
  return git(dir, ["ls-tree", "-r", "HEAD", "--name-only"])
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
}

export function porcelain(dir: string): string {
  return git(dir, ["status", "--porcelain"])
}
