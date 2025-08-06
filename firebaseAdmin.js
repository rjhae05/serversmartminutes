const admin = require("firebase-admin");
const fs = require("fs");

let serviceAccount;

try {
  const filePath = "/etc/secrets/smart-minutes-database-key"; // No `.json` extension if that's how it's stored
  const fileContents = fs.readFileSync(filePath, "utf8");
  serviceAccount = JSON.parse(fileContents);
} catch (error) {
  console.error("❌ Failed to load Firebase credentials:", error.message);
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://smartminutesdatabase-default-rtdb.firebaseio.com", // ✅ Realtime DB URL
  });

  console.log("✅ Firebase Admin initialized successfully with Realtime DB.");
} catch (error) {
  console.error("❌ Firebase Admin initialization failed:", error.message);
  process.exit(1);
}

module.exports = admin;


