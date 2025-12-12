// firebaseAdmin.js
require("dotenv").config(); // .env ফাইল লোড করার জন্য
const admin = require("firebase-admin");

// এই এক লাইনই যথেষ্ট! বাকি কিছু লিখতে হবে না
admin.initializeApp();

module.exports = admin;
