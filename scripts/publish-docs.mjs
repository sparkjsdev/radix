// Publishes the docs to GitHub Pages: builds the reference pages
// (scripts/build-docs.mjs), then copies docs/ to the root of the gh-pages
// branch, commits and pushes it. The branch is checked out in a temporary
// worktree, so the working tree here is left alone; when gh-pages does not
// exist yet it is created as an orphan branch.
//
//   node scripts/publish-docs.mjs             build, commit and push
//   node scripts/publish-docs.mjs --no-push   build and commit only
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const BRANCH = "gh-pages";
const REMOTE = "origin";
const PUSH = !process.argv.includes("--no-push");

const git = (args, cwd = ROOT) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const succeeds = (args) => {
  try {
    execFileSync("git", args, { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

execFileSync(process.execPath, [join(ROOT, "scripts", "build-docs.mjs")], { cwd: ROOT, stdio: "inherit" });

const source = git(["rev-parse", "--short", "HEAD"]);
const dirty = git(["status", "--porcelain", "--", "docs"]) !== "";

succeeds(["fetch", REMOTE, BRANCH]);
const remoteExists = succeeds(["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${BRANCH}`]);
const localExists = succeeds(["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`]);

const dir = mkdtempSync(join(tmpdir(), "radix-gh-pages-"));
try {
  if (localExists) {
    git(["worktree", "add", dir, BRANCH]);
    if (remoteExists) git(["merge", "--ff-only", `${REMOTE}/${BRANCH}`], dir);
  } else if (remoteExists) {
    git(["worktree", "add", "-b", BRANCH, dir, `${REMOTE}/${BRANCH}`]);
  } else {
    git(["worktree", "add", "--detach", dir]);
    git(["switch", "--orphan", BRANCH], dir);
  }

  // Replace everything on the branch with the current docs
  for (const name of readdirSync(dir)) {
    if (name !== ".git") rmSync(join(dir, name), { recursive: true, force: true });
  }
  cpSync(DOCS, dir, { recursive: true, filter: (src) => !src.endsWith(".DS_Store") });
  // Serve the files as they are, without Jekyll
  writeFileSync(join(dir, ".nojekyll"), "");

  git(["add", "--all"], dir);
  if (git(["status", "--porcelain"], dir) === "") {
    console.log(`${BRANCH} is already up to date`);
  } else {
    git(["commit", "--quiet", "-m", `Publish docs from ${source}${dirty ? " (with uncommitted changes)" : ""}`], dir);
    console.log(`Committed docs from ${source} to ${BRANCH}`);
  }
  if (PUSH) {
    execFileSync("git", ["push", REMOTE, BRANCH], { cwd: dir, stdio: "inherit" });
  }
} finally {
  git(["worktree", "remove", "--force", dir]);
}
