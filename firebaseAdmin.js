require('dotenv').config();
const admin = require("firebase-admin");
const fs = require("fs");
const path = "/etc/secrets/smart-minutes-database-key.json"; // or .js or whatever extension is used

let serviceAccount;

try {
  // Check if file exists
  if (fs.existsSync(path)) {
    const fileContents = fs.readFileSync(path, "utf8");
    serviceAccount = JSON.parse(fileContents);
  } else {
    throw new Error(`File not found at path: ${path}`);
  }
} catch (error) {
  console.error("❌ Failed to load Firebase credentials:", error);
  process.exit(1); // Exit early to avoid undefined credential issues
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://smartminutesdatabase-default-rtdb.firebaseio.com"
});

module.exports = admin;
