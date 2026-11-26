import crypto from "crypto";
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
import { PublicInquiryRoute } from "./app/modules/publicinquiry/publicinquiry.route";

const app: Application = express();

// Behind a proxy (Vercel/ngrok/nginx) — needed for correct client IPs in rate limiting
// Number of proxies in front of the server (1 = one proxy such as Vercel / nginx). Set TRUST_PROXY=0 when
// the server is reachable directly: otherwise a client can forge X-Forwarded-For and dodge the rate limits.
app.set(
  "trust proxy",
  Number.isNaN(Number(process.env.TRUST_PROXY ?? 1))
    ? 1
    : Number(process.env.TRUST_PROXY ?? 1),
);

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

// Public website form: no login, its own CORS, limits and parsers (before the global ones)
app.use("/api/v1/public", PublicInquiryRoute);

// Browsers allowed to call the API (and to open the live notification socket)
export const allowedOrigins = [
  "https://www.betonherstel-business-portal.vercel.app",
  "https://www.portal.business.betonherstel.nl",
  "https://portal.business.betonherstel.nl",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://localhost:3004",
];

// Local network (development): 192.168.68.10 and 192.168.68.100-109, any port, http
const lanOriginPattern = /^http:\/\/192\.168\.68\.10\d?(:\d{1,5})?$/;

// The one rule for CORS and for the live WebSocket upgrade
export const isAllowedOrigin = (origin: string) =>
  allowedOrigins.includes(origin) || lanOriginPattern.test(origin);

app.use(
  cors({
    // Requests without an Origin header (curl, Postman, server-to-server) are not browser CORS requests
    origin: (origin, callback) =>
      callback(null, !origin || isAllowedOrigin(origin)),
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
// Express 5 leaves req.body undefined when a request has no body; controllers read req.body.x
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.body === undefined) req.body = {};
  next();
});
app.use(
  "/uploads",
  express.static(path.join(__dirname, "..", "public", "uploads")),
);
console.log(path.join(__dirname, "..", "public", "uploads"));

// Simple status page for browsers; API clients that ask for JSON still get the old message
const renderStatusPage = (nonce: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Betonherstel Server</title>
  <style>
    :root { --bg: #f4f5f7; --card: #ffffff; --text: #1f2933; --muted: #6b7785; --accent: #e8590c; --ok: #2f9e44; --line: #e4e7eb; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #14171a; --card: #1e2227; --text: #eceff1; --muted: #9aa5b1; --line: #2c3238; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .card { width: 100%; max-width: 420px; padding: 40px 32px; text-align: center; background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06); }
    .logo { width: 56px; height: 56px; margin: 0 auto 20px; display: grid; place-items: center; border-radius: 14px; background: var(--accent); color: #fff; font-size: 28px; font-weight: 700; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0; color: var(--muted); font-size: 15px; }
    .status { display: inline-flex; align-items: center; gap: 8px; margin-top: 24px; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line); font-size: 14px; font-weight: 500; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 0 rgba(47, 158, 68, 0.6); animation: pulse 2s infinite; }
    @keyframes pulse { 70% { box-shadow: 0 0 0 8px rgba(47, 158, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(47, 158, 68, 0); } }
    button { display: block; margin: 20px auto 0; padding: 10px 22px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
    button:hover { opacity: 0.88; }
    button:disabled { opacity: 0.6; cursor: wait; }
    #result { min-height: 20px; margin-top: 12px; font-size: 13px; color: var(--muted); }
    footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">B</div>
    <h1>Betonherstel Server</h1>
    <p>The API is up and ready to receive requests.</p>
    <div class="status"><span class="dot"></span>Running</div>
    <button id="wake" type="button">Wake up server</button>
    <div id="result" aria-live="polite"></div>
    <footer>Betonherstel CRM &middot; API v1</footer>
  </main>
  <script nonce="${nonce}">
    var btn = document.getElementById("wake");
    var out = document.getElementById("result");
    btn.addEventListener("click", function () {
      btn.disabled = true;
      btn.textContent = "Waking up...";
      out.textContent = "";
      var started = Date.now();
      // A sleeping host can need a minute to start, so wait for it
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 90000);
      fetch("/", { headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          out.textContent = "Server is awake (" + (Date.now() - started) + " ms)";
        })
        .catch(function () {
          out.textContent = "Could not reach the server. Please try again.";
        })
        .finally(function () {
          clearTimeout(timer);
          btn.disabled = false;
          btn.textContent = "Wake up server";
        });
    });
  </script>
</body>
</html>`;

app.get("/", (req: Request, res: Response) => {
  if (req.accepts(["html", "json"]) === "json") {
    res.send({
      Message: "The betonherstel server is running. . .",
    });
    return;
  }
  // helmet's default policy blocks inline scripts; this page allows only its own, by a one-time nonce
  const nonce = crypto.randomBytes(16).toString("base64");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  res.type("html").send(renderStatusPage(nonce));
});

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use("/api/v1", apiLimiter);
app.use("/api/v1/auth", authLimiter);
app.use("/api/v1", router);

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
