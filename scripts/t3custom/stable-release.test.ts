// @effect-diagnostics nodeBuiltinImport:off - CI artifact verification uses dependency-free Node streams and the upstream manifest codec.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, expect, it } from "@effect/vitest";
import { parseUpdateManifest } from "../lib/update-manifest.ts";
import { finalizeStableArtifacts, stableVersion } from "./stable-release.ts";

describe("Custom stable release", () => {
  it("accepts only stable upstream tags from 0.1.8 onward", () => {
    for (const tag of ["v0.1.8", "v0.1.10", "v0.2.0", "v1.0.0"])
      assert.equal(stableVersion(tag), tag.slice(1));
    for (const tag of [
      "v0.1.7",
      "v0.0.99",
      "v0.1.8-nightly.20261107.1",
      "v0.1.8-rc.1",
      "v01.1.8",
      "0.1.8",
    ])
      assert.throws(() => stableVersion(tag));
  });

  it("refreshes the stapled DMG hash while refusing a changed update ZIP", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3custom-stable-test-"),
    );
    try {
      const zipName = "T3-Custom-0.1.8-arm64.zip";
      const dmgName = "T3-Custom-0.1.8-arm64.dmg";
      const zip = Buffer.from("signed and stapled app archive");
      const dmg = Buffer.from("installer with its appended Apple ticket");
      const sha512 = (value: Uint8Array) =>
        NodeCrypto.createHash("sha512").update(value).digest("base64");
      const manifest = `version: 0.1.8\nfiles:\n  - url: ${zipName}\n    sha512: ${sha512(zip)}\n    size: ${zip.length}\n  - url: ${dmgName}\n    sha512: before-stapling\n    size: 1\npath: ${zipName}\nsha512: ${sha512(zip)}\nreleaseDate: '2026-11-07T00:00:00Z'\n`;
      await NodeFSP.writeFile(NodePath.join(directory, zipName), zip);
      await NodeFSP.writeFile(NodePath.join(directory, dmgName), dmg);
      await NodeFSP.writeFile(NodePath.join(directory, `${zipName}.blockmap`), "zip blockmap");
      await NodeFSP.writeFile(NodePath.join(directory, "latest-mac.yml"), manifest);
      await finalizeStableArtifacts(directory, "0.1.8");
      const result = parseUpdateManifest(
        await NodeFSP.readFile(NodePath.join(directory, "latest-mac.yml"), "utf8"),
        "test",
        "macOS",
      );
      assert.deepStrictEqual(result.files, [
        { url: zipName, size: zip.length, sha512: sha512(zip) },
        { url: dmgName, size: dmg.length, sha512: sha512(dmg) },
      ]);
      await NodeFSP.writeFile(NodePath.join(directory, zipName), "changed ZIP");
      await expect(finalizeStableArtifacts(directory, "0.1.8")).rejects.toThrow(/ZIP.*changed/);
      await NodeFSP.writeFile(
        NodePath.join(directory, "latest-mac.yml"),
        manifest.replace(zipName, "../elsewhere.zip"),
      );
      await expect(finalizeStableArtifacts(directory, "0.1.8")).rejects.toThrow(/assets/);
      await NodeFSP.writeFile(NodePath.join(directory, "latest-mac.yml"), manifest);
      await expect(finalizeStableArtifacts(directory, "0.1.9")).rejects.toThrow(/version/);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
