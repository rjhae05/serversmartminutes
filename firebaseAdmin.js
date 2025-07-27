// firebase.js
const admin = require("firebase-admin");
const serviceAccount = require("./smart-minutes-database-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://smartminutesdatabase-default-rtdb.firebaseio.com"
});

module.exports = admin;
