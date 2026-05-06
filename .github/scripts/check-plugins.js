// .github/scripts/check-plugins.js
//
// Checks recent GitHub releases of configured plugins,
// compares them with the manifest files, and updates if new versions are found.
// Keeps only the latest MAX_VERSIONS version entries per plugin.

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const MAX_VERSIONS = 5;
const MAX_RELEASES_TO_CHECK = 10;
const REQUEST_TIMEOUT_MS = 60000; // 60 seconds

const PLUGINS = [
  {
    repo: "intro-skipper/segment-editor-plugin",
    guid: "ace21d44-a4e5-4a85-ae75-acd2e24a9574",
    changelogUrl:
      "https://github.com/intro-skipper/segment-editor-plugin/blob/master/CHANGELOG.md",
  },
  {
    repo: "intro-skipper/jellyfin-plugin-ms-chapter",
    guid: "e22fb8f5-bc98-4f76-9be4-87de302a97ea",
    changelogUrl:
      "https://github.com/intro-skipper/jellyfin-plugin-ms-chapter/blob/master/CHANGELOG.md",
  },
  {
    repo: "intro-skipper/skipme.db-plugin",
    guid: "b2a63e62-0ac5-4575-9ad2-2c7534ccb83d",
    changelogUrl:
      "https://github.com/intro-skipper/skipme.db-plugin/blob/main/CHANGELOG.md",
  },
];

// ── helpers ──────────────────────────────────────────────────────────

function ghFetch(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: urlPath,
      headers: {
        "User-Agent": "manifest-updater",
        Accept: "application/vnd.github+json",
      },
    };
    if (process.env.GITHUB_TOKEN) {
      options.headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const req = https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const url = new URL(res.headers.location);
          const opts = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            headers: { "User-Agent": "manifest-updater" },
          };
          const req2 = https
            .get(opts, (r2) => {
              let d = "";
              r2.on("data", (c) => (d += c));
              r2.on("end", () =>
                resolve({ statusCode: r2.statusCode, body: d }),
              );
              r2.on("error", reject);
            })
            .on("error", reject);
          req2.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req2.destroy();
            reject(new Error(`Request to ${urlPath} timed out`));
          });
        } else {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Request to ${urlPath} timed out`));
    });
  });
}

function rawFetch(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { "User-Agent": "manifest-updater" },
    };
    const req = https.get(options, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        return rawFetch(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`rawFetch to ${url} timed out`));
    });
  });
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { "User-Agent": "manifest-updater" },
    };
    const req = https.get(options, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(
            `Request to ${url} failed with status code ${res.statusCode}`,
          );
          err.statusCode = res.statusCode;
          return reject(err);
        }
        resolve(buffer);
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`downloadBuffer from ${url} timed out`));
    });
  });
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

function parseYamlValue(yamlText, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escapedKey}:\\s*"?([^"\\n]+)"?`, "m");
  const m = yamlText.match(re);
  return m ? m[1].trim() : null;
}

// ── per-plugin processing ─────────────────────────────────────────────

async function processPlugin(plugin, manifestCache, modifiedManifests) {
  const { repo, guid, changelogUrl } = plugin;
  console.log(`\n=== Processing ${repo} ===`);

  // Fetch recent releases (newest first)
  const releasesRes = await ghFetch(
    `/repos/${repo}/releases?per_page=${MAX_RELEASES_TO_CHECK}`,
  );
  if (releasesRes.statusCode !== 200) {
    console.error(
      `Failed to fetch releases for ${repo}: HTTP ${releasesRes.statusCode}`,
    );
    return { updated: false, summary: [] };
  }
  const releases = JSON.parse(releasesRes.body);
  if (!Array.isArray(releases) || releases.length === 0) {
    console.log(`No releases found for ${repo}.`);
    return { updated: false, summary: [] };
  }
  console.log(`Found ${releases.length} recent release(s).`);

  // Collect all versions already present across all manifests for this plugin
  const existingVersionsSet = new Set();
  for (const manifest of Object.values(manifestCache)) {
    const pluginEntry = manifest.find(
      (p) => p.guid.toLowerCase() === guid.toLowerCase(),
    );
    if (pluginEntry && Array.isArray(pluginEntry.versions)) {
      for (const v of pluginEntry.versions) {
        existingVersionsSet.add(v.version);
      }
    }
  }

  const newVersionsSummary = [];
  let anyUpdated = false;

  for (const release of releases) {
    if (release.draft || release.prerelease) {
      console.log(`Skipping draft/prerelease: ${release.tag_name}`);
      continue;
    }

    const tag = release.tag_name;
    let version = tag.startsWith("v") ? tag.slice(1) : tag;
    // Normalize versions with a hyphenated hash suffix (e.g. "0.4.2-68bd752" → "0.4.2.0")
    const hyphenIdx = version.indexOf("-");
    if (hyphenIdx !== -1) {
      version = version.substring(0, hyphenIdx);
      if (version.split(".").length < 4) {
        version += ".0";
      }
    }

    if (existingVersionsSet.has(version)) {
      console.log(`Version ${version} already in manifest. Skipping.`);
      continue;
    }

    console.log(`New version found: ${version} (tag: ${tag})`);

    // Fetch build.yaml at this tag to get targetAbi
    let buildRes;
    try {
      buildRes = await rawFetch(
        `https://raw.githubusercontent.com/${repo}/${tag}/build.yaml`,
      );
    } catch (err) {
      console.warn(
        `Could not fetch build.yaml at tag ${tag}: ${err.message}. Skipping.`,
      );
      continue;
    }
    if (buildRes.statusCode !== 200) {
      console.warn(
        `build.yaml not found at tag ${tag} (HTTP ${buildRes.statusCode}). Skipping.`,
      );
      continue;
    }
    const targetAbi = parseYamlValue(buildRes.body, "targetAbi");
    if (!targetAbi) {
      console.warn(
        `Could not parse targetAbi from build.yaml at tag ${tag}. Skipping.`,
      );
      continue;
    }
    console.log(`targetAbi: ${targetAbi}`);

    // Determine catalog directory from targetAbi (e.g. "10.11.5.0" → "10.11")
    const abiParts = targetAbi.split(".");
    if (abiParts.length < 2) {
      console.warn(
        `targetAbi "${targetAbi}" does not have enough segments. Skipping.`,
      );
      continue;
    }
    const catalogDir = abiParts.slice(0, 2).join(".");

    // Load manifest if not already cached
    if (!manifestCache[catalogDir]) {
      const manifestPath = path.join(catalogDir, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        console.warn(
          `Manifest ${manifestPath} does not exist. Skipping version ${version}.`,
        );
        continue;
      }
      manifestCache[catalogDir] = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8"),
      );
    }

    const manifest = manifestCache[catalogDir];
    const pluginIndex = manifest.findIndex(
      (p) => p.guid.toLowerCase() === guid.toLowerCase(),
    );
    if (pluginIndex === -1) {
      console.warn(
        `Plugin ${guid} not found in ${catalogDir}/manifest.json. Skipping.`,
      );
      continue;
    }
    const pluginEntry = manifest[pluginIndex];

    if (!Array.isArray(pluginEntry.versions)) {
      pluginEntry.versions = [];
    }

    // Double-check version doesn't exist in this specific manifest
    if (pluginEntry.versions.some((v) => v.version === version)) {
      console.log(
        `Version ${version} already in ${catalogDir}/manifest.json. Skipping.`,
      );
      existingVersionsSet.add(version);
      continue;
    }

    // Find zip asset
    const asset = release.assets.find((a) => a.name.endsWith(".zip"));
    if (!asset) {
      console.warn(`No .zip asset in release ${tag}. Skipping.`);
      continue;
    }

    // Download zip and compute MD5 checksum
    console.log(`Downloading ${asset.name} for MD5 checksum...`);
    let zipBuffer;
    try {
      zipBuffer = await downloadBuffer(asset.browser_download_url);
    } catch (err) {
      console.error(
        `Failed to download ${asset.browser_download_url}: ${err.message}. Skipping.`,
      );
      continue;
    }
    const checksum = crypto.createHash("md5").update(zipBuffer).digest("hex");
    console.log(`MD5: ${checksum}`);

    // Build new version entry
    const newEntry = {
      version,
      changelog: `- See the full changelog at [GitHub](${changelogUrl})`,
      targetAbi,
      sourceUrl: asset.browser_download_url,
      checksum,
      timestamp: release.published_at,
    };

    pluginEntry.versions.unshift(newEntry);
    existingVersionsSet.add(version);
    modifiedManifests.add(catalogDir);
    anyUpdated = true;
    newVersionsSummary.push(`${repo.split("/").pop()} v${version}`);
    console.log(`Added version ${version} to ${catalogDir}/manifest.json.`);
  }

  // Sort and trim versions for this plugin across all manifests
  for (const [catalogDir, manifest] of Object.entries(manifestCache)) {
    const pluginEntry = manifest.find(
      (p) => p.guid.toLowerCase() === guid.toLowerCase(),
    );
    if (!pluginEntry || !Array.isArray(pluginEntry.versions)) continue;
    pluginEntry.versions.sort((a, b) => {
      if (a.timestamp && b.timestamp) {
        return new Date(b.timestamp) - new Date(a.timestamp);
      }
      return b.version.localeCompare(a.version, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
    pluginEntry.versions = pluginEntry.versions.slice(0, MAX_VERSIONS);
  }

  return { updated: anyUpdated, summary: newVersionsSummary };
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  // Pre-load all manifest files from version directories (e.g. 10.8, 10.9, 10.10, 10.11)
  const manifestCache = {};
  const manifestDirs = fs
    .readdirSync(".")
    .filter(
      (d) =>
        /^\d+\.\d+$/.test(d) &&
        fs.statSync(d).isDirectory() &&
        fs.existsSync(path.join(d, "manifest.json")),
    );
  for (const dir of manifestDirs) {
    manifestCache[dir] = JSON.parse(
      fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"),
    );
    console.log(`Loaded ${dir}/manifest.json`);
  }

  const modifiedManifests = new Set();
  let anyUpdated = false;
  const allSummaries = [];

  for (const plugin of PLUGINS) {
    try {
      const result = await processPlugin(
        plugin,
        manifestCache,
        modifiedManifests,
      );
      if (result.updated) {
        anyUpdated = true;
        allSummaries.push(...result.summary);
      }
    } catch (err) {
      console.error(`Error processing plugin ${plugin.repo}:`, err);
      // Continue with remaining plugins
    }
  }

  // Write only modified manifests back to disk
  for (const catalogDir of modifiedManifests) {
    const manifestPath = path.join(catalogDir, "manifest.json");
    const manifest = manifestCache[catalogDir];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + "\n");
    console.log(`Wrote updated manifest: ${manifestPath}`);
  }

  if (anyUpdated) {
    const summary = allSummaries.join(", ");
    console.log(`\nUpdated: ${summary}`);
    setOutput("updated", "true");
    setOutput("summary", summary);
  } else {
    console.log("\nNo updates needed.");
    setOutput("updated", "false");
    setOutput("summary", "");
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
