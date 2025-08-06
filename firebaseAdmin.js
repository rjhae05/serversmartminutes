const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.SMART_MINUTES_DATABASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

