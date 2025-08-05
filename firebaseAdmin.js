require('dotenv').config();
const admin = require("firebase-admin");

// parse the JSON string from env to object
const serviceAccount = JSON.parse(process.env.SMART_MINUTES_DATABASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://smartminutesdatabase-default-rtdb.firebaseio.com"
});

module.exports = admin;
