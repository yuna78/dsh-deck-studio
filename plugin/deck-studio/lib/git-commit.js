/**
 * 本地 git 提交（页面微调 script 后自动留痕）。
 *
 * 只提交明确列出的文件：`git add -- <files>` + `git commit -- <files>`，
 * 不会把仓库里别人的改动带进来。提交失败只返回错误，不影响已经写好的文件。
 * @module dsh-plugin-deck-studio/git-commit
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** 找文件所属 git 仓库根（不在仓库里返回 null）。 */
export function findRepo(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * 提交指定文件。
 * @param {object} input
 * @param {string} input.dir 工作目录（repo 内任意路径）
 * @param {string[]} input.files 绝对路径
 * @param {string} input.message commit message
 * @returns {{ok: boolean, commit?: string, repo?: string, error?: string, output?: string}}
 */
export function commitFiles({ dir, files, message }) {
  const list = (files ?? []).filter((file) => existsSync(file));
  if (!list.length) return { ok: false, error: "没有需要提交的文件" };
  const repo = findRepo(dir);
  if (!repo) return { ok: false, error: "源 deck 不在 git 仓库里，已保存但未提交" };
  // macOS /tmp → /private/tmp 之类的符号链接会让 relative() 算出 ../，两边都取真实路径再比。
  const realRepo = realpathSync(repo);
  const rels = list.map((file) => relative(realRepo, realpathSync(file)));
  if (rels.some((rel) => rel.startsWith(".."))) return { ok: false, error: "文件在仓库外，拒绝提交" };
  try {
    git(repo, ["add", "--", ...rels]);
    const output = git(repo, ["commit", "-m", message, "--", ...rels]);
    const commit = git(repo, ["rev-parse", "--short", "HEAD"]);
    return { ok: true, commit, repo, output };
  } catch (error) {
    // F-104：commit 被拒（hook / 无身份 / 策略）时把 add 回滚，别把暂存条目（AD）留给用户。
    // 文件本身已写好，调用方仍然可以继续；只是「没提交」。
    try {
      git(repo, ["reset", "-q", "--", ...rels]);
    } catch {
      // 回滚失败不能覆盖真正的 commit 失败原因
    }
    const detail = String(error?.stderr ?? error?.message ?? error).trim().split("\n").slice(-3).join(" ");
    return { ok: false, repo, error: detail || "git commit 失败" };
  }
}

/**
 * 删除目录后清掉 index 里属于它的暂存条目（F-104）。
 *
 * 先 `findRepo(target)`（必须在 rm 之前调用，目录删了 git 就找不到仓库），
 * 再 `unstageRemovedPath(repo, target)`；这样不会留下 `AD` 之类的半删除状态。
 * @param {string} repo 仓库根
 * @param {string} target 已删除的绝对路径
 * @returns {boolean} 是否执行了清理
 */
export function unstageRemovedPath(repo, target) {
  if (!repo || !target) return false;
  try {
    // 目录已被 rm：realpath(target) 会失败，用「父目录真实路径 + 目录名」还原。
    let abs;
    try {
      abs = realpathSync(target);
    } catch {
      abs = join(realpathSync(dirname(target)), basename(target));
    }
    const rel = relative(realpathSync(repo), abs);
    if (!rel || rel.startsWith("..")) return false;
    git(repo, ["reset", "-q", "--", rel]);
    return true;
  } catch {
    return false;
  }
}
