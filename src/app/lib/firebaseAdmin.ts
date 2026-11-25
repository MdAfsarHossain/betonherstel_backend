import { cert, initializeApp } from "firebase-admin/app";
import { serviceAccount } from "../../config/serviceAccount";

// Push notifications need FIREBASE_SERVICE_ACCOUNT (see config/serviceAccount.ts); without it the app
// still starts and sending a push reports that it is not configured.
const admin = serviceAccount
  ? initializeApp({
      credential: cert(serviceAccount as any),
    })
  : (null as any);

export default admin;
