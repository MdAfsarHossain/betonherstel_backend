import { cert, initializeApp } from "firebase-admin/app";
import { serviceAccount } from "../../config/serviceAccount";

const admin = initializeApp({
  credential: cert(serviceAccount as any),
});

export default admin;
