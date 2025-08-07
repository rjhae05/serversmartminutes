var admin = require("firebase-admin");

var serviceAccount = require("/etc/secrets/smart-minutes-database-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://smartminutesdatabase-default-rtdb.firebaseio.com"
});

const db = admin.database(); 
