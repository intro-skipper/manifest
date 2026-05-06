// .github/scripts/check-segment-editor.js
//
// Checks the latest GitHub release of intro-skipper/segment-editor-plugin,
// compares it with the manifest, and updates if a new version is found.
// Keeps only the latest 5 version entries per plugin.

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const REPO = "intro-skipper/segment-editor-plugin";
const PLUGIN_GUID = "ace21d44-a4e5-4a85-ae75-acd2e24a9574";
const MAX_VERSIONS = 5;

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
    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          const url = new URL(res.headers.location);
          const opts = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            headers: { "User-Agent": "manifest-updater" },
          };
          https.get(opts, (r2) => {
            let d = "";
            r2.on("data", (c) => (d += c));
            r2.on("end", () => resolve({ statusCode: r2.statusCode, body: d }));
            r2.on("error", reject);
          }).on("error", reject);
        } else {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
      res.on("error", reject);
    }).on("error", reject);
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
    https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return rawFetch(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
      res.on("error", reject);
    }).on("error", reject);
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
    https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`Request to ${url} failed with status code ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.body = buffer;
          return reject(err);
        }
        resolve(buffer);
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

function parseYamlValue(yamlText, key) {
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m");
  const m = yamlText.match(re);
  return m ? m[1].trim() : null;
}

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  // 1. Fetch latest release
  console.log(`Fetching latest release from ${REPO}...`);
  const releaseRes = await ghFetch(`/repos/${REPO}/releases/latest`);
  if (releaseRes.statusCode !== 200) {
    console.error(`Failed to fetch latest release: HTTP ${releaseRes.statusCode}`);
    process.exit(1);
  }
  const release = JSON.parse(releaseRes.body);
  const tag = release.tag_name; // e.g. "v0.1.27.0"
  let version = tag.startsWith("v") ? tag.slice(1) : tag;
  // Normalize versions with a hyphenated hash suffix (e.g. "1.0.0-abc1234" → "1.0.0.0")
  const hyphenIdx = version.indexOf("-");
  if (hyphenIdx !== -1) {
    version = version.substring(0, hyphenIdx);
    if (version.split(".").length < 4) {
      version += ".0";
    }
  }
  const publishedAt = release.published_at;
  console.log(`Latest release: ${tag} (${publishedAt})`);

  // 2. Fetch build.yaml to get targetAbi
  console.log("Fetching build.yaml for targetAbi...");
  const buildRes = await rawFetch(
    `https://raw.githubusercontent.com/${REPO}/${tag}/build.yaml`
  );
  if (buildRes.statusCode !== 200) {
    console.error(`Failed to fetch build.yaml: HTTP ${buildRes.statusCode}`);
    process.exit(1);
  }
  const targetAbi = parseYamlValue(buildRes.body, "targetAbi");
  if (!targetAbi) {
    console.error("Could not parse targetAbi from build.yaml");
    process.exit(1);
  }
  console.log(`targetAbi: ${targetAbi}`);

  // 3. Determine catalog directory (e.g. "10.11")
  const abiParts = targetAbi.split(".");
  const catalogDir = abiParts.slice(0, 2).join(".");
  const manifestPath = path.join(catalogDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest file ${manifestPath} does not exist.`);
    process.exit(1);
  }

  // 4. Read manifest and check if version already exists
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const pluginIndex = manifest.findIndex((p) => p.guid === PLUGIN_GUID);

  if (pluginIndex === -1) {
    console.error(`Plugin with GUID ${PLUGIN_GUID} not found in ${manifestPath}.`);
    process.exit(1);
  }

  const plugin = manifest[pluginIndex];
  if (!Array.isArray(plugin.versions)) {
    console.error(
      `Plugin with GUID ${PLUGIN_GUID} has no valid 'versions' array in ${manifestPath}. Aborting.`,
    );
    process.exit(1);
  }

  const existingVersions = plugin.versions;
  const alreadyExists = existingVersions.some((v) => v.version === version);

  if (alreadyExists) {
    console.log(`Version ${version} already in manifest. Nothing to do.`);
    setOutput("updated", "false");
    return;
  }

  // 5. Find the zip asset and download it for MD5
  const asset = release.assets.find((a) => a.name.endsWith(".zip"));
  if (!asset) {
    console.error("No .zip asset found in the release.");
    process.exit(1);
  }
  const sourceUrl = asset.browser_download_url;
  console.log(`Downloading ${asset.name} for MD5 checksum...`);

  const zipBuffer = await downloadBuffer(sourceUrl);
  const checksum = crypto.createHash("md5").update(zipBuffer).digest("hex");
  console.log(`MD5 checksum: ${checksum}`);

  // 6. Build new version entry
  const newEntry = {
    version,
    changelog: `- See the full changelog at [GitHub](https://github.com/${REPO}/blob/master/CHANGELOG.md)`,
    targetAbi,
    sourceUrl,
    checksum,
    timestamp: publishedAt,
  };

  // 7. Add new entry, then sort by recency and keep only MAX_VERSIONS entries
  existingVersions.unshift(newEntry);
  existingVersions.sort((a, b) => {
    if (a.timestamp && b.timestamp) {
      const aTime = new Date(a.timestamp).getTime();
      const bTime = new Date(b.timestamp).getTime();
      return bTime - aTime; // newest first
    }
    if (a.version && b.version) {
      // Fallback: compare versions (descending, numeric-aware)
      return b.version.localeCompare(a.version, undefined, { numeric: true, sensitivity: "base" });
    }
    return 0;
  });
  plugin.versions = existingVersions.slice(0, MAX_VERSIONS);

  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
    console.error(
      `Post-update versions list is empty for plugin GUID ${PLUGIN_GUID} in ${manifestPath}. Aborting.`,
    );
    process.exit(1);
  }

  // 8. Write updated manifest
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + "\n");
  console.log(`Updated ${manifestPath} with version ${version}.`);
  console.log(`Kept ${plugin.versions.length} version(s) (max ${MAX_VERSIONS}).`);

  setOutput("updated", "true");
  setOutput("version", version);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
