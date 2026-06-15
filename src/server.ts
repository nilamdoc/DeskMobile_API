import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { MongoClient } from "mongodb";
import { nanoid } from "nanoid";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 7000);
const appUrl = String(process.env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, "");
const mongoUri = String(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017");
const databaseName = String(process.env.MONGODB_DATABASE || "deskmobile");
const collectionName = String(process.env.DESKMOBILE_COLLECTION || "desk_mobile_sessions");
const expiryMinutes = Number(process.env.QR_EXPIRY_MINUTES || 2);

const client = new MongoClient(mongoUri);

type DeskMobileSession = {
  link_token: string;
  qr_payload: string;
  status: "pending" | "approved" | "expired" | "cancelled";
  desktop_ip?: string;
  desktop_user_agent?: string;
  user_id?: string | null;
  user_ref?: string | null;
  approved_at?: string | null;
  expires_at: string;
  cancelled_at?: string | null;
  created_at: string;
  updated_at: string;
  meta?: Record<string, unknown>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function isPast(dateString: string): boolean {
  return new Date(dateString).getTime() < Date.now();
}

async function collection() {
  const db = client.db(databaseName);
  return db.collection<DeskMobileSession>(collectionName);
}

app.get("/", (_req, res) => {
  res.json({
    success: true,
    name: "DeskMobile API",
    endpoints: {
      create: "/api/deskmobile/link/create",
      status: "/api/deskmobile/link/status/:token",
      approve: "/api/deskmobile/link/approve",
      cancel: "/api/deskmobile/link/cancel",
      scan: "/api/deskmobile/scan/:token",
    },
  });
});

app.post("/api/deskmobile/link/create", async (req, res) => {
  const token = nanoid(80);
  const qrPayload = `${appUrl}/api/deskmobile/scan/${token}`;

  const session: DeskMobileSession = {
    link_token: token,
    qr_payload: qrPayload,
    status: "pending",
    desktop_ip: req.ip,
    desktop_user_agent: req.get("user-agent") || "",
    user_id: null,
    user_ref: null,
    approved_at: null,
    cancelled_at: null,
    expires_at: addMinutes(expiryMinutes),
    created_at: nowIso(),
    updated_at: nowIso(),
    meta: {
      created_from: "desktop",
    },
  };

  const col = await collection();
  await col.insertOne(session);

  res.json({
    success: true,
    token: session.link_token,
    qr_payload: session.qr_payload,
    status: session.status,
    expires_at: session.expires_at,
  });
});

app.get("/api/deskmobile/link/status/:token", async (req, res) => {
  const col = await collection();

  const session = await col.findOne({
    link_token: req.params.token,
  });

  if (!session) {
    res.status(404).json({
      success: false,
      status: "not_found",
      message: "Link session not found.",
    });
    return;
  }

  let status = session.status;

  if (status === "pending" && isPast(session.expires_at)) {
    status = "expired";

    await col.updateOne(
      { link_token: req.params.token },
      {
        $set: {
          status,
          updated_at: nowIso(),
        },
      }
    );
  }

  res.json({
    success: true,
    status,
    token: session.link_token,
    user_id: session.user_id || null,
    user_ref: session.user_ref || null,
    approved_at: session.approved_at || null,
    expires_at: session.expires_at,
  });
});

app.post("/api/deskmobile/link/approve", async (req, res) => {
  const token = String(req.body.token || "");
  const userRef = String(req.body.user_ref || "");
  const userId = String(req.body.user_id || userRef || "");

  if (!token || !userRef) {
    res.status(422).json({
      success: false,
      message: "token and user_ref are required.",
    });
    return;
  }

  const col = await collection();

  const session = await col.findOne({
    link_token: token,
  });

  if (!session) {
    res.status(404).json({
      success: false,
      message: "Invalid QR code.",
    });
    return;
  }

  if (session.status !== "pending") {
    res.status(422).json({
      success: false,
      message: "QR code already used or expired.",
      status: session.status,
    });
    return;
  }

  if (isPast(session.expires_at)) {
    await col.updateOne(
      { link_token: token },
      {
        $set: {
          status: "expired",
          updated_at: nowIso(),
        },
      }
    );

    res.status(422).json({
      success: false,
      message: "QR code expired.",
      status: "expired",
    });
    return;
  }

  await col.updateOne(
    { link_token: token },
    {
      $set: {
        status: "approved",
        user_id: userId,
        user_ref: userRef,
        approved_at: nowIso(),
        updated_at: nowIso(),
        meta: {
          ...(session.meta || {}),
          approved_from: "mobile",
          mobile_ip: req.ip,
          mobile_user_agent: req.get("user-agent") || "",
        },
      },
    }
  );

  res.json({
    success: true,
    message: "Desktop linked successfully.",
    status: "approved",
    user: {
      id: userId,
      ref: userRef,
    },
  });
});

app.post("/api/deskmobile/link/cancel", async (req, res) => {
  const token = String(req.body.token || "");

  if (!token) {
    res.status(422).json({
      success: false,
      message: "token is required.",
    });
    return;
  }

  const col = await collection();

  await col.updateOne(
    {
      link_token: token,
      status: "pending",
    },
    {
      $set: {
        status: "cancelled",
        cancelled_at: nowIso(),
        updated_at: nowIso(),
      },
    }
  );

  res.json({
    success: true,
    message: "Link session cancelled.",
  });
});

app.get("/api/deskmobile/scan/:token", (req, res) => {
  res.json({
    success: true,
    token: req.params.token,
    message: "Send this token to approve endpoint from mobile.",
    approve_endpoint: "/api/deskmobile/link/approve",
  });
});

async function start() {
  await client.connect();

  const col = await collection();
  await col.createIndex({ link_token: 1 }, { unique: true });
  await col.createIndex({ expires_at: 1 });

  app.listen(port, "0.0.0.0", () => {
    console.log(`DeskMobile API running on ${appUrl}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
