import { getMessaging } from "firebase-admin/messaging";
import app from "../lib/firebaseAdmin";

const sendSinglePushNotification = async (payload: {
  body: any;
  fcmToken: string;
}) => {
  const message = {
    notification: {
      title: payload.body.title,
      body: payload.body.body,
    },
    token: payload.fcmToken,
  };
  const response = await getMessaging(app).send(message);
  return response;
};
//something wrong

const sendPushNotification = async (payload: {
  body: any;
  fcmTokens: string[];
}) => {
  const message = {
    notification: {
      title: payload.body.title,
      body: payload.body.body,
    },
    tokens: payload.fcmTokens,
  };
  const response = await getMessaging(app).sendEachForMulticast(message);
  return response;
};

export const firebasePushNotificationServices = {
  sendSinglePushNotification,
  sendPushNotification,
};
