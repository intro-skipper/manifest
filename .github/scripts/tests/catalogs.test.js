const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { getCatalogDirectory } = require("../catalog-paths");

const scriptsDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(scriptsDir, "../..");
const stableFile = "manifest.json";
const prereleaseFile = "manifest-prerelease.json";
const introGuid = "c83d86bb-a1e0-4c35-a113-e2101cf4ee6b";
const segmentGuid = "ace21d44-a4e5-4a85-ae75-acd2e24a9574";
const segmentRepo = "intro-skipper/segment-editor-plugin";
const abiCases = [
  ["12.0.0.0", "12"],
  ["12.1.0.0", "12"],
  ["12.37.4.0", "12"],
  ["10.11.5.0", "10.11"],
];

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function versionEntry(version, targetAbi = "12.0.0.0", timestamp = "2026-01-01T00:00:00Z") {
  return {
    version,
    changelog: `Changes for ${version}`,
    targetAbi,
    sourceUrl: `https://example.test/plugin-${version}.zip`,
    checksum: "0123456789abcdef0123456789abcdef",
    timestamp,
  };
}

function pluginEntry(name, guid, versions) {
  return {
    name,
    guid,
    overview: `${name} overview`,
    description: `${name} description`,
    owner: "Intro Skipper",
    category: "MoviesAndShows",
    versions,
  };
}

function seedCatalog(cwd, dir, fileName, data) {
  fs.mkdirSync(path.join(cwd, dir), { recursive: true });
  fs.writeFileSync(path.join(cwd, dir, fileName), JSON.stringify(data, null, 4) + "\n");
}

function readCatalog(cwd, dir, fileName) {
  return fs.readFileSync(path.join(cwd, dir, fileName), "utf8");
}

function assertMirrored(cwd, fileName) {
  const canonical = path.join(cwd, "12", fileName);
  const compatibility = path.join(cwd, "12.0", fileName);
  assert.ok(fs.lstatSync(canonical).isFile());
  assert.ok(fs.lstatSync(compatibility).isFile());
  assert.deepEqual(fs.readFileSync(compatibility), fs.readFileSync(canonical));
}

function runScript(script, cwd, { payload, responses } = {}) {
  const outputFile = path.join(cwd, "github-output");
  const requestLog = path.join(cwd, "http-requests");
  fs.writeFileSync(outputFile, "");
  fs.writeFileSync(requestLog, "");
  const env = { ...process.env, GITHUB_OUTPUT: outputFile };
  delete env.GITHUB_TOKEN;
  delete env.CLIENT_PAYLOAD_JSON;
  if (payload) env.CLIENT_PAYLOAD_JSON = JSON.stringify(payload);
  const args = [];
  if (responses) {
    env.MOCK_HTTP_RESPONSES = JSON.stringify(responses);
    env.MOCK_HTTP_LOG = requestLog;
    args.push("--require", path.join(__dirname, "fixtures/mock-https.cjs"));
  }
  args.push(path.join(scriptsDir, script));
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  return {
    ...result,
    output: fs.readFileSync(outputFile, "utf8"),
    requests: fs.readFileSync(requestLog, "utf8").split("\n").filter(Boolean),
  };
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test("catalog selection groups only Jellyfin 12.x by major", () => {
  for (const [version, expected] of [
    ...abiCases,
    ["12.0", "12"],
    ["12.99.0", "12"],
    ["10.8.13.0", "10.8"],
    ["10.10.7.0", "10.10"],
    ["11.1.0.0", "11.1"],
    ["13.1.0.0", "13.1"],
  ]) {
    assert.equal(getCatalogDirectory(version), expected, version);
  }
});

test("committed 12 catalogs and 12.0 compatibility files are identical regular JSON files", () => {
  for (const fileName of [stableFile, prereleaseFile]) {
    assertMirrored(repoRoot, fileName);
    assert.ok(Array.isArray(JSON.parse(readCatalog(repoRoot, "12", fileName))));
  }
});

for (const [script, fileName] of [
  ["update-manifest.js", stableFile],
  ["update-prerelease-manifest.js", prereleaseFile],
]) {
  for (const [targetAbi, catalogDir] of abiCases) {
    test(`${script} preserves update semantics for ${targetAbi} in ${catalogDir}`, (t) => {
      const cwd = workspace(t);
      const oldVersions = [versionEntry("0.6.0.0"), versionEntry("0.5.0.0")];
      const original = [
        pluginEntry("Intro Skipper", introGuid, oldVersions),
        pluginEntry("Segment Editor", segmentGuid, [versionEntry("0.1.0.0")]),
      ];
      seedCatalog(cwd, catalogDir, fileName, original);
      if (catalogDir === "12") {
        seedCatalog(cwd, "12.0", fileName, []);
        seedCatalog(cwd, "10.11", fileName, original);
      }
      const otherFile = fileName === stableFile ? prereleaseFile : stableFile;
      seedCatalog(cwd, catalogDir, otherFile, original);
      const untouchedChannel = readCatalog(cwd, catalogDir, otherFile);
      const newEntry = versionEntry("0.7.0.0", targetAbi);
      const payload = { pluginName: "Intro Skipper", ...newEntry };
      assertSuccess(runScript(script, cwd, { payload }));

      const expected = structuredClone(original);
      expected[0].versions = fileName === stableFile ? [newEntry, ...oldVersions] : [newEntry];
      const suffix = fileName === stableFile ? "" : "\n";
      assert.equal(readCatalog(cwd, catalogDir, fileName), JSON.stringify(expected, null, 4) + suffix);
      if (catalogDir === "12") assertMirrored(cwd, fileName);

      const replacement = {
        ...newEntry,
        version: fileName === stableFile ? newEntry.version : "0.7.0.1",
        changelog: "Replacement changelog",
      };
      assertSuccess(runScript(script, cwd, { payload: { pluginName: "Intro Skipper", ...replacement } }));
      expected[0].versions = fileName === stableFile ? [replacement, ...oldVersions] : [replacement];
      assert.equal(readCatalog(cwd, catalogDir, fileName), JSON.stringify(expected, null, 4) + suffix);
      assert.equal(readCatalog(cwd, catalogDir, otherFile), untouchedChannel);
      if (catalogDir === "12") {
        assertMirrored(cwd, fileName);
        assert.equal(readCatalog(cwd, "10.11", fileName), JSON.stringify(original, null, 4) + "\n");
        assert.ok(!fs.existsSync(path.join(cwd, "12.1")));
        assert.ok(!fs.existsSync(path.join(cwd, "12.37")));
      } else {
        assert.ok(!fs.existsSync(path.join(cwd, "12")));
        assert.ok(!fs.existsSync(path.join(cwd, "12.0")));
      }
    });
  }

  test(`${script} retains plugin-version fallback when targetAbi is unusable`, (t) => {
    const cwd = workspace(t);
    seedCatalog(cwd, "12", fileName, [pluginEntry("Intro Skipper", introGuid, [])]);
    for (const targetAbi of [undefined, null, "", "12", "invalid.abi"]) {
      const payload = {
        pluginName: "Intro Skipper",
        ...versionEntry("12.1.2.3"),
        targetAbi,
      };
      assertSuccess(runScript(script, cwd, { payload }));
      const updated = JSON.parse(readCatalog(cwd, "12", fileName));
      assert.equal(updated[0].versions[0].version, payload.version);
      assert.equal(updated[0].versions[0].targetAbi, targetAbi);
      assertMirrored(cwd, fileName);
    }
  });

  test(`${script} requires the canonical catalog and never reads the compatibility copy`, (t) => {
    const cwd = workspace(t);
    seedCatalog(cwd, "12.0", fileName, [pluginEntry("Intro Skipper", introGuid, [])]);
    const before = readCatalog(cwd, "12.0", fileName);
    const result = runScript(script, cwd, {
      payload: { pluginName: "Intro Skipper", ...versionEntry("12.0.1.0") },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Catalog directory "12" does not exist/);
    assert.equal(readCatalog(cwd, "12.0", fileName), before);
  });
}

for (const script of ["check-plugins.js", "check-segment-editor.js"]) {
  for (const [targetAbi, catalogDir] of abiCases) {
    test(`${script} updates ${catalogDir} for ${targetAbi}, trims history, and skips existing releases`, (t) => {
      const cwd = workspace(t);
      const oldVersions = [1, 5, 2, 4, 3].map((n) =>
        versionEntry(`0.6.${n}.0`, targetAbi, `2026-01-0${n}T00:00:00Z`),
      );
      const original = [
        pluginEntry("Segment Editor", segmentGuid, oldVersions),
        pluginEntry("Intro Skipper", introGuid, [versionEntry("12.0.4.0")]),
      ];
      seedCatalog(cwd, catalogDir, stableFile, original);
      seedCatalog(cwd, catalogDir, prereleaseFile, original);
      const prereleaseBefore = readCatalog(cwd, catalogDir, prereleaseFile);
      if (catalogDir === "12") {
        seedCatalog(cwd, "12.0", stableFile, [
          pluginEntry("Segment Editor", segmentGuid, [versionEntry("0.7.0.0")]),
        ]);
        seedCatalog(cwd, "10.11", stableFile, [original[1]]);
      }

      const tag = "v0.7.0-abc1234";
      const sourceUrl = `https://github.com/${segmentRepo}/releases/download/${tag}/segment-editor.zip`;
      const release = {
        tag_name: tag,
        published_at: "2026-02-01T00:00:00Z",
        draft: false,
        prerelease: false,
        assets: [{ name: "segment-editor.zip", browser_download_url: sourceUrl }],
      };
      const zip = "Offline zip fixture bytes";
      const buildUrl = `https://raw.githubusercontent.com/${segmentRepo}/${tag}/build.yaml`;
      const responses = {
        [buildUrl]: `targetAbi: "${targetAbi}"\n`,
        [sourceUrl]: zip,
      };
      if (script === "check-plugins.js") {
        responses[`https://api.github.com/repos/${segmentRepo}/releases?per_page=10`] = JSON.stringify([
          { ...release, tag_name: "v99.0.0.0", prerelease: true },
          { ...release, tag_name: "v98.0.0.0", draft: true },
          release,
          { ...release, tag_name: "v0.6.3.0" },
        ]);
        for (const repo of ["jellyfin-plugin-ms-chapter", "skipme.db-plugin"]) {
          responses[`https://api.github.com/repos/intro-skipper/${repo}/releases?per_page=10`] = "[]";
        }
      } else {
        responses[`https://api.github.com/repos/${segmentRepo}/releases/latest`] = JSON.stringify(release);
      }

      const result = runScript(script, cwd, { responses });
      assertSuccess(result);
      assert.match(result.output, /^updated=true$/m);
      assert.equal(result.requests.filter((url) => url === sourceUrl).length, 1);
      const expected = structuredClone(original);
      expected[0].versions = [
        {
          version: "0.7.0.0",
          changelog: `- See the full changelog at [GitHub](https://github.com/${segmentRepo}/blob/master/CHANGELOG.md)`,
          targetAbi,
          sourceUrl,
          checksum: crypto.createHash("md5").update(zip).digest("hex"),
          timestamp: release.published_at,
        },
        ...[...oldVersions].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 4),
      ];
      const updatedBytes = JSON.stringify(expected, null, 4) + "\n";
      assert.equal(readCatalog(cwd, catalogDir, stableFile), updatedBytes);
      assert.equal(readCatalog(cwd, catalogDir, prereleaseFile), prereleaseBefore);
      if (catalogDir === "12") {
        assertMirrored(cwd, stableFile);
        assert.equal(readCatalog(cwd, "10.11", stableFile), JSON.stringify([original[1]], null, 4) + "\n");
        if (script === "check-plugins.js") {
          assert.match(result.stdout, /^Loaded 12\/manifest.json$/m);
          assert.doesNotMatch(result.stdout, /^Loaded 12\.0\//m);
        }
      } else {
        assert.ok(!fs.existsSync(path.join(cwd, "12")));
        assert.ok(!fs.existsSync(path.join(cwd, "12.0")));
      }

      delete responses[sourceUrl];
      if (script === "check-plugins.js") delete responses[buildUrl];
      const repeated = runScript(script, cwd, { responses });
      assertSuccess(repeated);
      assert.match(repeated.output, /^updated=false$/m);
      assert.equal(readCatalog(cwd, catalogDir, stableFile), updatedBytes);
      if (catalogDir === "12") assertMirrored(cwd, stableFile);
    });
  }
}
