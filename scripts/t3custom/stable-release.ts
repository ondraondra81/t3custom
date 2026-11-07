// @effect-diagnostics nodeBuiltinImport:off - CI artifact verification uses dependency-free Node streams and the upstream manifest codec.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { parseUpdateManifest, serializeUpdateManifest } from "../lib/update-manifest.ts";

export function stableVersion(tag: string): string {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (
    !match ||
    (BigInt(match[1]!) === 0n &&
      (BigInt(match[2]!) === 0n || (BigInt(match[2]!) === 1n && BigInt(match[3]!) < 8n)))
  )
    throw new Error("Custom updates require an upstream stable tag from v0.1.8 onward.");
  return tag.slice(1);
}

async function fileHash(file: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha512");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

export async function finalizeStableArtifacts(directory: string, version: string) {
  stableVersion(`v${version}`);
  const manifestPath = NodePath.join(directory, "latest-mac.yml");
  const manifest = parseUpdateManifest(
    await NodeFSP.readFile(manifestPath, "utf8"),
    manifestPath,
    "macOS",
  );
  if (manifest.version !== version)
    throw new Error("Update manifest version does not match the release.");
  const zipName = `T3-Custom-${version}-arm64.zip`;
  const dmgName = `T3-Custom-${version}-arm64.dmg`;
  if (
    manifest.files.length !== 2 ||
    new Set(manifest.files.map((file) => file.url)).size !== 2 ||
    manifest.files.some((file) => file.url !== zipName && file.url !== dmgName)
  )
    throw new Error("Update manifest must contain exactly the Custom arm64 ZIP and DMG assets.");
  const blockmap = await NodeFSP.stat(NodePath.join(directory, `${zipName}.blockmap`));
  if (!blockmap.isFile() || blockmap.size === 0) throw new Error("Update ZIP blockmap is missing.");
  const files = [];
  for (const file of manifest.files) {
    const path = NodePath.join(directory, file.url);
    const size = (await NodeFSP.stat(path)).size;
    const sha512 = await fileHash(path);
    if (file.url === zipName && (file.size !== size || file.sha512 !== sha512))
      throw new Error(
        "Update ZIP changed after packaging; its manifest and blockmap cannot be trusted.",
      );
    files.push({ ...file, size, sha512 });
  }
  // Stapling appends the DMG ticket after electron-builder writes the feed; the ZIP stays unchanged.
  await NodeFSP.writeFile(
    manifestPath,
    serializeUpdateManifest({ ...manifest, files }, { platformLabel: "macOS" }),
  );
}

if (import.meta.main) {
  const [command, value, directory = "release"] = process.argv.slice(2);
  if (!value) throw new Error("Expected stable-version <tag> or finalize <version> [directory].");
  if (command === "stable-version") process.stdout.write(`${stableVersion(value)}\n`);
  else if (command === "finalize") await finalizeStableArtifacts(directory, value);
  else throw new Error("Unknown stable release command.");
}
