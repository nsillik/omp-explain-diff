import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureSnapshot } from "./snapshot";
import type { DiffSnapshot } from "./snapshot";

const execute = promisify(execFile);
const fixtures: string[] = [];

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execute("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function repository(initial: Record<string, string | Buffer> = { "file.txt": "before\n" }) {
  const directory = await mkdtemp(join(tmpdir(), "omp-snapshot-test-"));
  fixtures.push(directory);
  const root = await realpath(directory);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Snapshot Test");
  await git(root, "config", "user.email", "snapshot@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "config", "core.autocrlf", "false");
  await git(root, "config", "core.quotePath", "true");
  for (const [path, content] of Object.entries(initial)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await git(root, "add", "-A");
  await git(root, "commit", "--allow-empty", "-m", "Initial");
  return root;
}

async function commit(root: string, message: string) {
  await git(root, "add", "-A");
  await git(root, "commit", "--allow-empty", "-m", message);
  return await git(root, "rev-parse", "HEAD");
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test("captures tracked, staged, deleted and untracked changes without touching the real index", async () => {
  const root = await repository({ "file.txt": "before\n", "deleted.txt": "gone\n", ".gitignore": "ignored/\n" });
  await writeFile(join(root, "file.txt"), "staged\n");
  await git(root, "add", "file.txt");
  await writeFile(join(root, "file.txt"), "working\nextra\n");
  await rm(join(root, "deleted.txt"));
  await writeFile(join(root, "new file.txt"), "new\n");
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "secret.txt"), "not captured\n");
  const indexBefore = await readFile(join(root, ".git", "index"));
  const snapshot = await captureSnapshot(root, "uncommitted");
  expect(await readFile(join(root, ".git", "index"))).toEqual(indexBefore);
  expect(snapshot.repoRoot).toBe(root);
  expect(snapshot.target).toBe("uncommitted working-tree changes");
  expect(snapshot.files.map(file => file.path).sort()).toEqual(["deleted.txt", "file.txt", "new file.txt"]);
  expect(snapshot.additions).toBe(3);
  expect(snapshot.deletions).toBe(2);
  expect(snapshot.patch).toContain("+working");
  expect(snapshot.patch).not.toContain("+staged");
  expect(snapshot.patch).not.toContain("not captured");
  const capturedFiles = structuredClone(snapshot.files);
  await writeFile(join(root, "file.txt"), "mutated after capture\n");
  await writeFile(join(root, "new file.txt"), "also changed\n");
  const immutablePatch = await execute("git", ["-c", "color.ui=false", "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", snapshot.baseRevision, snapshot.headRevision, "--"], { cwd: root });
  expect(immutablePatch.stdout).toBe(snapshot.patch);
  expect(snapshot.files).toEqual(capturedFiles);
  expect(await git(root, "show", `${snapshot.headRevision}:file.txt`)).toBe("working\nextra");
  expect((await captureSnapshot(root, "uncommitted")).identity).toBe(snapshot.identity);
});

test("path targets resolve from invocation cwd, preserve spaces and exclude unrelated changes", async () => {
  const root = await repository({ "nested dir/a file.txt": "before\n", "other.txt": "unchanged\n" });
  await writeFile(join(root, "nested dir", "a file.txt"), "after\n");
  await writeFile(join(root, "other.txt"), "unrelated\n");
  await writeFile(join(root, "new.txt"), "untracked unrelated\n");
  const snapshot = await captureSnapshot(join(root, "nested dir"), "a file.txt");
  expect(snapshot.target).toBe("nested dir/a file.txt");
  expect(snapshot.files.map(file => file.path)).toEqual(["nested dir/a file.txt"]);
  expect(await git(root, "show", `${snapshot.headRevision}:other.txt`)).toBe("unchanged");
  expect(snapshot.patch).not.toContain("unrelated");
  expect(snapshot.identity).toBe((await captureSnapshot(root, "nested dir/a file.txt")).identity);
});

test("tracked deleted and untracked path targets are captured in isolation", async () => {
  const root = await repository({ "space dir/deleted file.txt": "gone\n", "keep.txt": "keep\n" });
  await rm(join(root, "space dir", "deleted file.txt"));
  await git(root, "add", "-u");
  const before = await readFile(join(root, ".git", "index"));
  await writeFile(join(root, "new file.txt"), "fresh\n");
  const deleted = await captureSnapshot(join(root, "space dir"), "deleted file.txt");
  expect(deleted.files).toEqual([{ path: "space dir/deleted file.txt", additions: 0, deletions: 1, bytes: null }]);
  const added = await captureSnapshot(root, "new file.txt");
  expect(added.files).toEqual([{ path: "new file.txt", additions: 1, deletions: 0, bytes: null }]);
  expect(await git(root, "show", `${added.headRevision}:space dir/deleted file.txt`)).toBe("gone");
  expect(await readFile(join(root, ".git", "index"))).toEqual(before);
});

test("ignored path failures leave the user's index untouched", async () => {
  const root = await repository({ ".gitignore": "ignored.txt\n", "file.txt": "before\n" });
  await writeFile(join(root, "ignored.txt"), "ignored\n");
  const before = await readFile(join(root, ".git", "index"));
  await expect(captureSnapshot(root, "ignored.txt")).rejects.toThrow(Error);
  expect(await readFile(join(root, ".git", "index"))).toEqual(before);
});

test("unborn repositories can snapshot their first untracked files", async () => {
  const root = await repository();
  await git(root, "update-ref", "-d", "refs/heads/main");
  await rm(join(root, ".git", "index"));
  const snapshot = await captureSnapshot(root, "uncommitted");
  expect(snapshot.files.map(file => file.path)).toEqual(["file.txt"]);
  expect(snapshot.additions).toBe(1);
  expect(snapshot.deletions).toBe(0);
});

test("root and ordinary commits use immutable parents and bare hashes mean commits", async () => {
  const root = await repository();
  const first = await git(root, "rev-parse", "HEAD");
  const initial = await captureSnapshot(root, `commit ${first}`);
  expect(initial.additions).toBe(1);
  expect(initial.deletions).toBe(0);
  expect(await git(root, "cat-file", "-t", initial.baseRevision)).toBe("tree");
  await writeFile(join(root, "file.txt"), "next\n");
  const second = await commit(root, "Second");
  const snapshot = await captureSnapshot(root, second);
  expect(snapshot.baseRevision).toBe(first);
  expect(snapshot.headRevision).toBe(second);
  expect(snapshot.files).toEqual([{ path: "file.txt", additions: 1, deletions: 1, bytes: null }]);
  expect(snapshot.identity).toBe((await captureSnapshot(root, `commit ${second}`)).identity);
  expect(initial.identity).not.toBe(snapshot.identity);
});

test("rename and binary metadata use exact immutable blobs, including deleted binaries", async () => {
  const oldBinary = Buffer.from([0, 1, 2, 3, 4]);
  const newBinary = Buffer.from([0, 11, 12, 13, 14, 15, 16]);
  const root = await repository({ "old name.txt": "same\n", "deleted.bin": oldBinary, "changed.bin": oldBinary });
  await rename(join(root, "old name.txt"), join(root, "new\tname.txt"));
  await rm(join(root, "deleted.bin"));
  await writeFile(join(root, "changed.bin"), newBinary);
  const snapshot = await captureSnapshot(root, "uncommitted");
  expect(snapshot.files.find(file => file.path === "new\tname.txt")).toEqual({ path: "new\tname.txt", oldPath: "old name.txt", additions: 0, deletions: 0, bytes: null });
  expect(snapshot.files.find(file => file.path === "deleted.bin")).toEqual({ path: "deleted.bin", additions: null, deletions: null, bytes: oldBinary.length });
  expect(snapshot.files.find(file => file.path === "changed.bin")).toEqual({ path: "changed.bin", additions: null, deletions: null, bytes: newBinary.length });
  expect(snapshot.patch).toContain("GIT binary patch");
  await writeFile(join(root, "changed.bin"), Buffer.alloc(4096));
  expect(snapshot.files.find(file => file.path === "changed.bin")?.bytes).toBe(newBinary.length);
});

test("explicit comparisons, two-dot, three-dot and branch targets respect divergent history", async () => {
  const root = await repository();
  const common = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "-b", "feature");
  await writeFile(join(root, "feature.txt"), "feature\n");
  const feature = await commit(root, "Feature");
  await git(root, "checkout", "main");
  await writeFile(join(root, "main.txt"), "main\n");
  const main = await commit(root, "Main advanced");
  const comparison = await captureSnapshot(root, "feature vs main");
  expect(comparison.baseRevision).toBe(common);
  expect(comparison.headRevision).toBe(feature);
  expect(comparison.files.map(file => file.path)).toEqual(["feature.txt"]);
  const direct = await captureSnapshot(root, "main..feature");
  expect(direct.baseRevision).toBe(main);
  expect(direct.files.map(file => file.path).sort()).toEqual(["feature.txt", "main.txt"]);
  expect(direct.patch).not.toBe(comparison.patch);
  const merged = await captureSnapshot(root, "main...feature");
  expect(merged.baseRevision).toBe(common);
  expect(merged.files.map(file => file.path)).toEqual(["feature.txt"]);
  expect(merged.patch).toBe(comparison.patch);
  const branch = await captureSnapshot(root, "feature");
  expect(branch.patch).toBe(merged.patch);
  expect(branch.identity).not.toBe(merged.identity);
  expect(direct.identity).not.toBe(merged.identity);
  expect((await captureSnapshot(root, "feature vs default")).patch).toBe(comparison.patch);
});

test("standard PR refs resolve and fetch once without gh or fabricated branch names", async () => {
  const origin = await repository();
  await git(origin, "checkout", "-b", "release");
  await writeFile(join(origin, "release.txt"), "release\n");
  const base = await commit(origin, "Release base");
  await git(origin, "checkout", "-b", "topic");
  await writeFile(join(origin, "pr.txt"), "pull request\n");
  const head = await commit(origin, "PR change");
  await git(origin, "update-ref", "refs/pull/42/head", head);
  await git(origin, "update-ref", "refs/pull/43/head", head);
  await git(origin, "checkout", "release");
  await git(origin, "merge", "--no-ff", "-m", "Synthetic PR merge", "topic");
  await git(origin, "update-ref", "refs/pull/42/merge", "HEAD");
  await git(origin, "checkout", "main");
  const local = await repository();
  await git(local, "remote", "add", "origin", origin);
  const bin = join(local, "isolated-bin");
  await mkdir(bin);
  const gitExecutable = Bun.which("git");
  if (!gitExecutable) throw new Error("Git is required for snapshot behavior tests.");
  await symlink(gitExecutable, join(bin, "git"));
  const trace = join(local, "git-trace.log");
  const moduleUrl = new URL("./snapshot.ts", import.meta.url).href;
  const childScript = `
    import { captureSnapshot } from ${JSON.stringify(moduleUrl)};
    const snapshot = await captureSnapshot(process.cwd(), \"0042\");
    const same = await captureSnapshot(process.cwd(), \"#42\");
    let missingBaseRejected = false;
    try {
      await captureSnapshot(process.cwd(), \"#43\");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      missingBaseRejected = true;
    }
    process.stdout.write(JSON.stringify({ snapshot, same, missingBaseRejected }));
  `;
  const { stdout } = await execute(process.execPath, ["--eval", childScript], {
    cwd: local,
    env: { ...process.env, PATH: bin, GIT_TRACE: trace },
  });
  const result: {
    snapshot: DiffSnapshot;
    same: DiffSnapshot;
    missingBaseRejected: boolean;
  } = JSON.parse(stdout);
  expect(result.snapshot.target).toBe("#42");
  expect(result.snapshot.baseRevision).toBe(base);
  expect(result.snapshot.headRevision).toBe(head);
  expect(result.snapshot.files.map(file => file.path)).toEqual(["pr.txt"]);
  expect(result.same.identity).toBe(result.snapshot.identity);
  expect(result.same.patch).toBe(result.snapshot.patch);
  expect(result.missingBaseRejected).toBe(true);
  const fetchCalls = (await readFile(trace, "utf8")).split("\n").filter(line => line.includes("built-in: git") && line.includes(" fetch "));
  expect(fetchCalls).toHaveLength(1);
});

test("unknown and option-looking revisions fail instead of executing options or shell syntax", async () => {
  const root = await repository();
  await expect(captureSnapshot(root, "commit --help")).rejects.toThrow(Error);
  await expect(captureSnapshot(root, "commit HEAD; touch injected.txt")).rejects.toThrow(Error);
  await expect(readFile(join(root, "injected.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(captureSnapshot(root, "missing-file-or-ref")).rejects.toThrow(Error);
  await expect(captureSnapshot(root, " ")).rejects.toThrow(Error);
});
