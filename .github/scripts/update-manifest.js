// .github/scripts/update-manifest.js
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

// --- Determine catalog directory and version for commit message ---
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

const catalogFilePath = path.join(catalogDirName, "manifest.json");

try {
  if (!fs.existsSync(catalogDirName)) {
    console.error(`Error: Catalog directory "${catalogDirName}" does not exist. Cannot add version to non-existent catalog.`);
    process.exit(1); // Fail if the base directory for the catalog doesn't exist
  }

  let catalogData = [];
  if (fs.existsSync(catalogFilePath)) {
    console.log(`Reading existing catalog file: ${catalogFilePath}`);
    const fileContent = fs.readFileSync(catalogFilePath, "utf-8");
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
  } else {
    // If the specific manifest.json for a version (e.g. 10.10/manifest.json) doesn't exist,
    // it implies no plugins are yet listed for this Jellyfin ABI series.
    // This might be an error if we expect the plugin to already be in a catalog.
    console.error(`Error: Catalog file ${catalogFilePath} does not exist. Cannot add version to a non-existent plugin list.`);
    process.exit(1);
  }

  // Find the plugin to update within the catalog
  const pluginIndex = catalogData.findIndex(
    (p) => p.name === pluginNameToUpdate,
  );

  if (pluginIndex !== -1) {
    // Plugin found, add new version to the beginning of its versions array
    if (!Array.isArray(catalogData[pluginIndex].versions)) {
      console.warn(`Plugin "${pluginNameToUpdate}" found but 'versions' is not an array. Initializing it.`);
      catalogData[pluginIndex].versions = [];
    }
    // Optional: Check if this exact version already exists to prevent duplicates
    const existingVersionIndex = catalogData[pluginIndex].versions.findIndex(
      v => v.version === newVersionEntry.version
    );
    if (existingVersionIndex !== -1) {
      console.warn(`Warning: Version ${newVersionEntry.version} already exists for plugin "${pluginNameToUpdate}". Overwriting.`);
      catalogData[pluginIndex].versions[existingVersionIndex] = newVersionEntry; // Overwrite
    } else {
      catalogData[pluginIndex].versions.unshift(newVersionEntry); // Add to top
    }
    console.log(`Updated/Added version ${newVersionEntry.version} for plugin "${pluginNameToUpdate}".`);
  } else {
    // Plugin not found - THIS IS NOW AN ERROR CONDITION
    console.error(`Error: Plugin "${pluginNameToUpdate}" not found in catalog file "${catalogFilePath}". Cannot add new version.`);
    process.exit(1); // Fail the script
  }

  fs.writeFileSync(catalogFilePath, JSON.stringify(catalogData, null, 4));

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