require('dotenv').config();
const admin = require("firebase-admin");

// Parse the JSON service account key stored in the Railway environment variable
const serviceAccount = JSON.parse(process.env.SMART_MINUTES_DATABASE_KEY.replace(/\\n/g, '\n'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://smartminutesdatabase-default-rtdb.firebaseio.com"
});

module.exports = admin;
