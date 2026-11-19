import cors from "cors";
import express, { Application, NextFunction, Request, Response } from "express";
import httpStatus from "http-status";
import globalErrorHandler from "./app/errors/globalErrorHandler";
import router from "./app/routes";
import path from "path";
import morgan from "morgan";
import helmet from "helmet";
import compression from "compression";
import { rateLimit } from "express-rate-limit";
import { WebhookRoute } from "./app/modules/webhooks/webhook.route";

const app: Application = express();

// Behind a proxy (Vercel/ngrok/nginx) — needed for correct client IPs in rate limiting
app.set("trust proxy", 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT) || 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests, please try again later!",
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts, please try again later!",
  },
});

// app.use(
//   cors({
//     origin: "*",
//     methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//   })
// );

// Browsers allowed to call the API (and to open the live notification socket)
export const allowedOrigins = [
  "https://www.betonherstel-business-portal.vercel.app",
  "https://www.portal.business.betonherstel.nl",
  "https://portal.business.betonherstel.nl",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "ngrok-skip-browser-warning", // Keep for dev, harmless in production
    ],
    credentials: true,
  }),
);

app.use("/webhooks", WebhookRoute);

//parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  "/uploads",
  express.static(path.join(__dirname, "..", "public", "uploads")),
);
console.log(path.join(__dirname, "..", "public", "uploads"));

app.get("/", (req: Request, res: Response) => {
  res.send({
    Message: "The betonherstel server is running. . .",
  });
});

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use("/api/v1", apiLimiter);
app.use("/api/v1/auth", authLimiter);
app.use("/api/v1", router);
// app.use("/api/v2", router);

app.use(globalErrorHandler);

app.use((req: Request, res: Response, next: NextFunction) => {
  res.status(httpStatus.NOT_FOUND).json({
    success: false,
    message: "API NOT FOUND!",
    error: {
      path: req.originalUrl,
      message: "Your requested path is not found!",
    },
  });
});

export default app;
