// core/utils/locations.js
//
// A small named address-book of lat/long pairs, so adding an entry with
// a specific location doesn't mean retyping coordinates every time.
// Stored separately from dailyLog.xlsx (data/locations.json) since it's
// a reusable lookup list, not a submission record.

const fs = require("fs");
const path = require("path");
const config = require("../config");

function locationsFilePath() {
  return path.join(config.paths.data, "locations.json");
}

/** @returns {Array<{name: string, latitude: number, longitude: number}>} */
function readLocations() {
  const filePath = locationsFilePath();
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
}

function writeLocations(locations) {
  fs.writeFileSync(locationsFilePath(), JSON.stringify(locations, null, 2));
}

function addLocation({ name, latitude, longitude }) {
  const locations = readLocations();
  locations.push({ name: String(name).trim(), latitude: Number(latitude), longitude: Number(longitude) });
  writeLocations(locations);
  return locations;
}

/** @param {number} index - position in the list, as returned by readLocations(). */
function removeLocation(index) {
  const locations = readLocations();
  locations.splice(index, 1);
  writeLocations(locations);
  return locations;
}

module.exports = { readLocations, addLocation, removeLocation };
