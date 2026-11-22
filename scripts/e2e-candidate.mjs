import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function sourceResource(file, destination) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Source resource must be a regular file: ${file}`);
  }
  const data = await readFile(file);
  if (destination) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, data, { mode: info.mode & 0o777, flag: "wx" });
  }
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  };
}

export async function sourceInventory(directory, destination) {
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  async function walk(relative = "") {
    const entries = (await readdir(path.join(directory, relative))).sort();
    for (const entry of entries) {
      if (
        entry === "__pycache__" ||
        entry.endsWith(".pyc") ||
        entry.endsWith(".pyo")
      )
        continue;
      const name = path.join(relative, entry);
      const from = path.join(directory, name);
      const info = await lstat(from);
      if (info.isSymbolicLink())
        throw new Error(`Source inventory refuses symlinks: ${name}`);
      if (info.isDirectory()) {
        await walk(name);
        continue;
      }
      if (!info.isFile()) throw new Error(`Unexpected source object: ${name}`);
      const data = await readFile(from);
      hash
        .update(`${name.replaceAll(path.sep, "/")}\0${data.length}\0`)
        .update(data);
      bytes += data.length;
      files += 1;
      if (destination) {
        const to = path.join(destination, name);
        await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        await writeFile(to, data, { mode: info.mode & 0o777, flag: "wx" });
      }
    }
  }
  await walk();
  return { sha256: hash.digest("hex"), bytes, files };
}
