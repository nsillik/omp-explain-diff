import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type DiffFile = {
  path: string;
  oldPath?: string;
  additions: number | null;
  deletions: number | null;
  bytes: number | null;
};

export type DiffSnapshot = {
  repoRoot: string;
  target: string;
  identity: string;
  baseRevision: string;
  headRevision: string;
  patch: string;
  files: DiffFile[];
  additions: number;
  deletions: number;
};

function command(
  executable: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  input = "",
): Promise<string> {
  const { promise, resolve: resolveOutput, reject } = Promise.withResolvers<string>();
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.on("error", reject);
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") reject(error);
  });
  child.on("close", (code, signal) => {
    if (code === 0) resolveOutput(Buffer.concat(stdout).toString("utf8"));
    else reject(new Error(`${executable} ${args[0] ?? ""} failed (${signal ?? code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
  });
  child.stdin.end(input);
  return promise;
}

export async function captureSnapshot(cwd: string, target: string): Promise<DiffSnapshot> {
  const invocationCwd = await realpath(cwd);
  const git = (args: string[], env?: NodeJS.ProcessEnv, input?: string) =>
    command("git", args, invocationCwd, env, input);
  const repoRoot = await realpath((await git(["rev-parse", "--show-toplevel"])).trim());
  // Disable external diff/textconv and color: sidecars must contain the actual Git blobs.
  const repoGit = (args: string[], env?: NodeJS.ProcessEnv, input?: string) =>
    command("git", ["-c", "color.ui=false", ...args], repoRoot, env, input);
  const revision = async (ref: string) =>
    (await repoGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  const optionalRevision = async (ref: string) => {
    try { return await revision(ref); } catch { return undefined; }
  };
  const emptyTree = async () =>
    (await repoGit(["hash-object", "-w", "-t", "tree", "--stdin"], undefined, "")).trim();
  const defaultRevision = async () => {
    for (const ref of ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"]) {
      const oid = await optionalRevision(ref);
      if (oid) return oid;
    }
    throw new Error("Cannot determine the default branch; set origin/HEAD or create main/master, or specify an explicit base.");
  };
  const mergeBase = async (base: string, head: string) =>
    (await repoGit(["merge-base", base, head])).trim();
  const commitBase = async (head: string) => {
    const parents = (await repoGit(["rev-list", "--parents", "-n", "1", head])).trim().split(" ");
    return parents[1] ?? await emptyTree();
  };

  let label = target.trim();
  if (!label) throw new Error("A diff target is required.");
  let kind: string;
  let identityParts: string[];
  let baseRevision: string;
  let headRevision: string;
  let pathspec: string[] = [];

  const captureWorkingTree = async (path?: string) => {
    const base = await optionalRevision("HEAD") ?? await emptyTree();
    const directory = await mkdtemp(join(tmpdir(), "omp-diff-index-"));
    const env = { GIT_INDEX_FILE: join(directory, "index") };
    try {
      await repoGit(["read-tree", base], env);
      await repoGit(["add", "-A", "--", path === undefined ? "." : `:(literal)${path}`], env);
      const head = (await repoGit(["write-tree"], env)).trim();
      return { base, head };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  const pr = /^(?:PR\s*)?#?(\d+)$/i.exec(label);
  const explicitCommit = /^commit\s+(.+)$/i.exec(label);
  const versus = /^(.+?)\s+vs\s+(.+)$/i.exec(label);
  const range = /^(.+?)(\.{2,3})([^.].*)$/.exec(label);
  if (/^(?:uncommitted|uncommitted working-tree changes)$/i.test(label)) {
    kind = "uncommitted";
    identityParts = [];
    label = "uncommitted working-tree changes";
    ({ base: baseRevision, head: headRevision } = await captureWorkingTree());
  } else if (pr) {
    kind = "pr";
    const number = pr[1].replace(/^0+(?=\d)/, "");
    if (number === "0") throw new Error("A GitHub PR number must be positive.");
    label = `#${number}`;
    identityParts = [number];
    let base: string;
    let head: string;
    let mergeRef: string | undefined;
    try {
      const metadata: unknown = JSON.parse(await command("gh", ["pr", "view", number, "--json", "baseRefOid,headRefOid,baseRefName"], repoRoot));
      if (!metadata || typeof metadata !== "object" || !("baseRefOid" in metadata) || !("headRefOid" in metadata)
        || typeof metadata.baseRefOid !== "string" || typeof metadata.headRefOid !== "string"
        || !/^[a-f0-9]{40,64}$/.test(metadata.baseRefOid) || !/^[a-f0-9]{40,64}$/.test(metadata.headRefOid)) {
        throw new Error("gh returned invalid PR revision metadata");
      }
      base = metadata.baseRefOid;
      head = metadata.headRefOid;
    } catch (ghError) {
      // A published PR merge ref records the real base, even for a nondefault target branch.
      try {
        const refs = await repoGit(["ls-remote", "origin", `refs/pull/${number}/head`, `refs/pull/${number}/merge`]);
        const lines = refs.trim().split("\n");
        const oidFor = (name: string) => lines.map(line => line.split("\t")).find(parts => parts[1] === name && /^[a-f0-9]{40,64}$/.test(parts[0] ?? ""))?.[0];
        const remoteHead = oidFor(`refs/pull/${number}/head`);
        mergeRef = oidFor(`refs/pull/${number}/merge`);
        if (!remoteHead || !mergeRef) throw new Error(`origin does not expose matching PR head and merge refs; install/authenticate gh to resolve PR #${number}'s base accurately.`);
        base = mergeRef;
        head = remoteHead;
      } catch (fallbackError) {
        throw new Error(`Cannot resolve PR #${number}: ${String(ghError)}; Git fallback: ${String(fallbackError)}`);
      }
    }
    const missing = [...new Set([base, head, ...(mergeRef ? [mergeRef] : [])])];
    const available = await Promise.all(missing.map(oid => optionalRevision(oid)));
    const fetchOids = missing.filter((_, index) => !available[index]);
    if (fetchOids.length) await repoGit(["fetch", "--no-tags", "--", "origin", ...fetchOids]);
    if (mergeRef) {
      const parents = (await repoGit(["rev-list", "--parents", "-n", "1", mergeRef])).trim().split(" ");
      if (parents.length !== 3 || parents[2] !== head) throw new Error(`PR #${number} merge ref is stale; install/authenticate gh to resolve its base accurately.`);
      base = parents[1];
    }
    headRevision = await revision(head);
    baseRevision = await mergeBase(await revision(base), headRevision);
  } else if (explicitCommit) {
    kind = "commit";
    const ref = explicitCommit[1].trim();
    identityParts = [ref];
    label = `commit ${ref}`;
    headRevision = await revision(ref);
    baseRevision = await commitBase(headRevision);
  } else if (versus) {
    kind = "comparison";
    const head = versus[1].trim();
    const base = versus[2].trim();
    identityParts = [head, base];
    label = `${head} vs ${base}`;
    [headRevision, baseRevision] = await Promise.all([revision(head), base === "default" ? defaultRevision() : revision(base)]);
    baseRevision = await mergeBase(baseRevision, headRevision);
  } else if (range) {
    kind = range[2] === "..." ? "merge-range" : "range";
    identityParts = [range[1], range[3]];
    [baseRevision, headRevision] = await Promise.all([revision(range[1]), revision(range[3])]);
    if (range[2] === "...") baseRevision = await mergeBase(baseRevision, headRevision);
  } else {
    const absolutePath = resolve(invocationCwd, label);
    const repositoryPath = relative(repoRoot, absolutePath).split(sep).join("/");
    const withinRepository = repositoryPath !== ".." && !repositoryPath.startsWith("../") && !isAbsolute(repositoryPath);
    let exists = false;
    try { await lstat(absolutePath); exists = true; } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
    }
    let tracked = false;
    if (!exists && withinRepository) {
      const head = await optionalRevision("HEAD");
      tracked = !!head && (await repoGit(["ls-tree", "-r", "--name-only", "-z", head, "--", repositoryPath || "."], { GIT_LITERAL_PATHSPECS: "1" })).length > 0;
    }
    if ((exists || tracked) && withinRepository) {
      kind = "path";
      const path = repositoryPath || ".";
      identityParts = [path];
      label = path;
      pathspec = [`:(literal)${path}`];
      ({ base: baseRevision, head: headRevision } = await captureWorkingTree(path));
    } else {
      const ref = label;
      headRevision = await revision(ref);
      const symbolicRef = (await repoGit(["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", ref])).trim();
      if (symbolicRef.startsWith("refs/heads/") || symbolicRef.startsWith("refs/remotes/")) {
        kind = "branch";
        identityParts = [ref, "default"];
        baseRevision = await mergeBase(await defaultRevision(), headRevision);
      } else {
        kind = "commit";
        identityParts = [ref];
        label = `commit ${ref}`;
        baseRevision = await commitBase(headRevision);
      }
    }
  }

  const diffArgs = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", baseRevision, headRevision, "--", ...pathspec];
  const [patch, numstat, raw] = await Promise.all([
    repoGit(["diff", "--binary", "--full-index", ...diffArgs]),
    repoGit(["diff", "--numstat", "-z", ...diffArgs]),
    repoGit(["diff", "--raw", "--no-abbrev", "-z", ...diffArgs]),
  ]);
  const blobs = new Map<string, { oldOid: string; newOid: string; oldPath?: string }>();
  const rawFields = raw.split("\0");
  for (let index = 0; index < rawFields.length && rawFields[index];) {
    const header = rawFields[index++].split(" ");
    const oldPath = rawFields[index++];
    const renamed = /^[RC]/.test(header[4]);
    const path = renamed ? rawFields[index++] : oldPath;
    blobs.set(path, { oldOid: header[2], newOid: header[3], ...(renamed ? { oldPath } : {}) });
  }
  const files: DiffFile[] = [];
  const binaryOids: string[] = [];
  const fields = numstat.split("\0");
  for (let index = 0; index < fields.length && fields[index];) {
    const record = fields[index++];
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    const added = record.slice(0, firstTab);
    const removed = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (!path) { index++; path = fields[index++]; }
    const blob = blobs.get(path);
    if (!blob) throw new Error(`Missing immutable blob metadata for ${JSON.stringify(path)}.`);
    const binary = added === "-";
    files.push({ path, ...(blob.oldPath ? { oldPath: blob.oldPath } : {}), additions: binary ? null : Number(added), deletions: binary ? null : Number(removed), bytes: null });
    if (binary) binaryOids.push(/^0+$/.test(blob.newOid) ? blob.oldOid : blob.newOid);
  }
  if (binaryOids.length) {
    const uniqueOids = [...new Set(binaryOids)];
    const sizes = new Map<string, number>();
    const output = await repoGit(["cat-file", "--batch-check=%(objectname) %(objectsize)"], undefined, `${uniqueOids.join("\n")}\n`);
    for (const line of output.trim().split("\n")) {
      const [oid, size] = line.split(" ");
      if (!/^\d+$/.test(size ?? "")) throw new Error(`Cannot determine binary blob size for ${oid}.`);
      sizes.set(oid, Number(size));
    }
    let binaryIndex = 0;
    for (const file of files) if (file.additions === null) file.bytes = sizes.get(binaryOids[binaryIndex++]) ?? null;
  }
  return {
    repoRoot, target: label, identity: JSON.stringify([repoRoot, kind, ...identityParts]),
    baseRevision, headRevision, patch, files,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
}
