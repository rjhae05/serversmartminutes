// Only used locally — doesn't affect Railway
require('dotenv').config();

const admin = require("firebase-admin");

// 🔐 Check that the environment variable exists
if (!process.env.SMART_MINUTES_DATABASE_KEY) {
  throw new Error("❌ Missing SMART_MINUTES_DATABASE_KEY in environment variables.");
}

let serviceAccount;

try {
  // 🔧 Parse the Firebase JSON key from the env variable
  serviceAccount = JSON.parse(process.env.SMART_MINUTES_DATABASE_KEY);
} catch (error) {
  throw new Error("❌ Failed to parse SMART_MINUTES_DATABASE_KEY: " + error.message);
}

// 🚀 Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://smartminutesdatabase-default-rtdb.firebaseio.com"
});

module.exports = admin;
