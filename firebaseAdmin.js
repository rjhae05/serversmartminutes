const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

let serviceAccountPath = path.join(__dirname, "../serviceAccountKey.json"); // fallback for local
if (process.env.RENDER) {
  serviceAccountPath = "/etc/secrets/smart-minutes-database-key";
}

let serviceAccount;
try {
  serviceAccount = require(serviceAccountPath);
} catch (error) {
  console.error("❌ Failed to load Firebase credentials:", error);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
