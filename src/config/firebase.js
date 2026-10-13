import fs from "fs";
import path from "path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const keyPath = path.join(process.cwd(), "firebase-key.json");
const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));

const app = initializeApp({
  credential: cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = getFirestore(app);

export { db, app as admin };
