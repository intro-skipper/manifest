const fs = require("fs");
const path = require("path");

function getCatalogDirectory(version) {
  const prefix = version.split(".").slice(0, 2).join(".");
  return /^12\.\d+$/.test(prefix) ? "12" : prefix;
}

function writeCatalog(catalogDir, fileName, content) {
  fs.writeFileSync(path.join(catalogDir, fileName), content);
  if (catalogDir === "12") {
    fs.mkdirSync("12.0", { recursive: true });
    fs.writeFileSync(path.join("12.0", fileName), content);
  }
}

module.exports = { getCatalogDirectory, writeCatalog };
