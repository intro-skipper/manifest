// .github/scripts/update-prerelease-manifest.js
//
// Handles the "update-prerelease-manifest" repository dispatch sent by the
// intro-skipper build workflow after every commit. Unlike stable releases,
// prerelease builds are published to manifest-prerelease.json and the
// catalog only ever contains the single most recent build, because the
// rolling prerelease GitHub release is replaced on every commit.
const fs = require("fs");
const path = require("path");

const clientPayloadJson = process.env.CLIENT_PAYLOAD_JSON;

if (!clientPayloadJson) {
  console.error(
    "Error: CLIENT_PAYLOAD_JSON environment variable is not set.",
  );
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(clientPayloadJson);
  console.log("Parsed CLIENT_PAYLOAD_JSON successfully.");
  console.log("Payload content:", payload);
} catch (e) {
  console.error("Error: Could not parse CLIENT_PAYLOAD_JSON.", e);
  process.exit(1);
}

// --- Extract data from payload ---
const pluginNameToUpdate = payload.pluginName;
console.log(`Plugin to update: ${pluginNameToUpdate}`);
const newVersionEntry = {
  version: payload.version,
  changelog: payload.changelog,
  targetAbi: payload.targetAbi,
  sourceUrl: payload.sourceUrl,
  checksum: payload.checksum,
  timestamp: payload.timestamp,
};

if (!pluginNameToUpdate || typeof pluginNameToUpdate !== "string") {
  console.error("Error: 'pluginName' field is missing or not a string in the client_payload.");
  process.exit(1);
}
if (!newVersionEntry.version || typeof newVersionEntry.version !== "string") {
  console.error("Error: 'version' (for the new plugin entry) is missing or not a string in the client_payload.");
  process.exit(1);
}

// --- Determine catalog directory from the targetAbi (same as update-manifest.js) ---
const catalogVersionSource = newVersionEntry.targetAbi;

let catalogDirName = newVersionEntry.version.split(".").slice(0, 2).join(".");

if (typeof catalogVersionSource === "string") {
  try {
    const parts = catalogVersionSource.split(".");
    if (parts.length >= 2) {
      const extractedPrefix = parts.slice(0, 2).join(".");
      if (/^\d+\.\d+$/.test(extractedPrefix)) {
        catalogDirName = extractedPrefix;
        console.log(`Using extracted prefix "${extractedPrefix}" from new version's targetAbi ("${catalogVersionSource}") for catalog directory.`);
      } else {
        console.warn(`Could not extract a valid 'major.minor' prefix from new version's targetAbi "${catalogVersionSource}". Using default "${catalogDirName}".`);
      }
    } else {
      console.warn(`New version's targetAbi "${catalogVersionSource}" does not have enough parts. Using default "${catalogDirName}".`);
    }
  } catch (e) {
    console.warn(`Error processing new version's targetAbi: ${e.message}. Using default "${catalogDirName}".`);
  }
} else {
  console.log(`New version's targetAbi is not a string. Using default "${catalogDirName}" for catalog directory.`);
}

const catalogFilePath = path.join(catalogDirName, "manifest-prerelease.json");

try {
  if (!fs.existsSync(catalogDirName)) {
    console.error(`Error: Catalog directory "${catalogDirName}" does not exist. Cannot add version to non-existent catalog.`);
    process.exit(1);
  }

  if (!fs.existsSync(catalogFilePath)) {
    console.error(`Error: Catalog file ${catalogFilePath} does not exist. Cannot update a non-existent prerelease catalog.`);
    process.exit(1);
  }

  console.log(`Reading existing catalog file: ${catalogFilePath}`);
  const fileContent = fs.readFileSync(catalogFilePath, "utf-8");
  let catalogData;
  try {
    catalogData = JSON.parse(fileContent);
    if (!Array.isArray(catalogData)) {
      console.error(`Error: Content of ${catalogFilePath} is not a JSON array. Cannot process.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: Could not parse JSON from ${catalogFilePath}. Error: ${e.message}`);
    process.exit(1);
  }

  // Find the plugin to update within the catalog
  const pluginIndex = catalogData.findIndex(
    (p) => p.name === pluginNameToUpdate,
  );

  if (pluginIndex === -1) {
    console.error(`Error: Plugin "${pluginNameToUpdate}" not found in catalog file "${catalogFilePath}". Cannot add new version.`);
    process.exit(1);
  }

  // The prerelease catalog only keeps the single most recent build, since
  // the rolling prerelease release only hosts the newest archive.
  catalogData[pluginIndex].versions = [newVersionEntry];
  console.log(`Set version ${newVersionEntry.version} as the only prerelease entry for plugin "${pluginNameToUpdate}".`);

  fs.writeFileSync(catalogFilePath, JSON.stringify(catalogData, null, 4) + "\n");

  console.log(`Successfully updated catalog file: ${catalogFilePath}`);
  const updatedPluginForLog = catalogData.find(p => p.name === pluginNameToUpdate);
  console.log("--- Updated Plugin Entry ---");
  console.log(JSON.stringify(updatedPluginForLog, null, 2));
  console.log("----------------------------");

  process.exit(0);
} catch (error) {
  console.error(`Error processing catalog file ${catalogFilePath}:`, error);
  process.exit(1);
}
