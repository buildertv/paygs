import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import axios from "axios";
import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { nanoid } from "nanoid";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = "/app/data";

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: "100kb" }));
app.use(express.static("/app/public"));

// ============================================================
// SQLite
// ============================================================

const db = new Database(path.join(DATA_DIR, "orders.db"));

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  ma_file TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  paid_at TEXT,
  download_token_hash TEXT,
  download_token_expiry TEXT,
  download_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_orders_token
ON orders(download_token_hash);
`);

// ============================================================
// Product CSV
// ============================================================

let products = new Map();
let lastCsvLoad = 0;

const CSV_TTL_MS = 60_000;

function clean(v) {
  return String(v ?? "").trim();
}

async function loadProducts(force = false) {
  if (
    !force &&
    Date.now() - lastCsvLoad < CSV_TTL_MS &&
    products.size
  ) {
    return products;
  }

  const url = process.env.PRODUCT_CSV_URL;

  if (!url) {
    throw new Error("PRODUCT_CSV_URL chưa được cấu hình");
  }

  const response = await axios.get(url, {
    timeout: 15000,
    responseType: "text"
  });

  const rows = parse(response.data, {
    columns: true,
    skip_empty_lines: true,
    bom: true
  });

  const map = new Map();

  for (const row of rows) {
    const ma = clean(row.MaFile).toLowerCase();

    if (!ma) continue;

    map.set(ma, {
      MaFile: ma,
      Ten: clean(row.Ten),
      Gia: Number(
        String(row.Gia || "0").replace(/[^\d-]/g, "")
      ),
      LinkFile: clean(row.LinkFile),
      LinkVideo: clean(row.LinkVideo),
      TrangThai: clean(row.TrangThai)
    });
  }

  products = map;
  lastCsvLoad = Date.now();

  return products;
}

// ============================================================
// Order ID
// ============================================================

function makeOrderId() {
  const d = new Date();

  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");

  return `HT${yy}${mm}${dd}-${nanoid(6).toUpperCase()}`;
}

// ============================================================
// Download Token
// ============================================================

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function createDownloadToken(orderId) {
  const token = `${orderId}.${nanoid(32)}`;

  const minutes = Number(
    process.env.DOWNLOAD_TOKEN_MINUTES || 30
  );

  const expiry = new Date(
    Date.now() + minutes * 60_000
  ).toISOString();

  db.prepare(`
    UPDATE orders
    SET download_token_hash=?,
        download_token_expiry=?
    WHERE id=?
  `).run(
    hashToken(token),
    expiry,
    orderId
  );

  return token;
}

// ============================================================
// Payment authentication
// n8n -> Node.js
// ============================================================

function authPayment(req) {
  const expected = clean(
    process.env.PAYMENT_WEBHOOK_SECRET
  );

  const got = clean(
    req.get("x-payment-secret")
  );

  if (!expected || !got) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const gotBuffer = Buffer.from(got);

  // timingSafeEqual yêu cầu 2 Buffer có cùng độ dài
  if (expectedBuffer.length !== gotBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    gotBuffer
  );
}

// ============================================================
// API: Product
// GET /api/product/v508
// ============================================================

app.get("/api/product/:maFile", async (req, res) => {
  try {
    const ma = clean(req.params.maFile).toLowerCase();

    const p = (await loadProducts()).get(ma);

    if (!p || p.TrangThai !== "1") {
      return res.status(404).json({
        error: "Không tìm thấy sản phẩm"
      });
    }

    // Tạo đơn hàng mới
    const orderId = makeOrderId();

    db.prepare(`
      INSERT INTO orders(
        id,
        ma_file,
        amount,
        status,
        created_at
      )
      VALUES (?, ?, ?, 'PENDING', ?)
    `).run(
      orderId,
      p.MaFile,
      p.Gia,
      new Date().toISOString()
    );

    // Nội dung chuyển khoản = OrderID
    const addInfo = encodeURIComponent(orderId);

    const bankCode = encodeURIComponent(
      process.env.BANK_CODE || ""
    );

    const bankAccount = encodeURIComponent(
      process.env.BANK_ACCOUNT || ""
    );

    const accountName = encodeURIComponent(
      process.env.BANK_ACCOUNT_NAME || ""
    );

    const qr =
      `https://img.vietqr.io/image/` +
      `${bankCode}-${bankAccount}-compact2.png` +
      `?amount=${p.Gia}` +
      `&addInfo=${addInfo}` +
      `&accountName=${accountName}`;

    // LƯU Ý:
    // Không trả LinkFile về frontend.
    res.json({
      maFile: p.MaFile,
      ten: p.Ten,
      gia: p.Gia,
      linkVideo: p.LinkVideo,
      orderId,
      qr
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: "Lỗi máy chủ"
    });
  }
});

// ============================================================
// API: Check order status
// GET /api/order/:orderId/status
// ============================================================

app.get(
  "/api/order/:orderId/status",
  (req, res) => {

    const row = db.prepare(`
      SELECT
        id,
        ma_file,
        amount,
        status,
        paid_at
      FROM orders
      WHERE id=?
    `).get(req.params.orderId);

    if (!row) {
      return res.status(404).json({
        error: "Không tìm thấy đơn hàng"
      });
    }

    res.json({
      status: row.status,
      amount: row.amount,
      paidAt: row.paid_at,
      downloadUrl: null
    });
  }
);

// ============================================================
// API: Payment Confirm
// n8n gọi sau khi SePay xác nhận giao dịch
//
// Header:
// x-payment-secret: PAYMENT_WEBHOOK_SECRET
//
// Body:
// {
//   "orderId": "...",
//   "amount": 300000,
//   "status": "PAID"
// }
// ============================================================

app.post(
  "/api/payment-confirm",
  (req, res) => {

    if (!authPayment(req)) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }

    const {
      orderId,
      amount,
      status
    } = req.body || {};

    const order = db
      .prepare(
        "SELECT * FROM orders WHERE id=?"
      )
      .get(clean(orderId));

    if (!order) {
      return res.status(404).json({
        error: "Order không tồn tại"
      });
    }

    if (
      Number(amount) !== Number(order.amount)
    ) {
      return res.status(400).json({
        error: "Sai số tiền"
      });
    }

    if (status !== "PAID") {
      return res.status(400).json({
        error: "Status không hợp lệ"
      });
    }

    // Nếu đã PAID thì không cần xử lý lại
    if (order.status !== "PAID") {
      const paidAt = new Date().toISOString();

      db.prepare(`
        UPDATE orders
        SET status='PAID',
            paid_at=?
        WHERE id=?
      `).run(
        paidAt,
        order.id
      );
    }

    const token = createDownloadToken(
      order.id
    );

    res.json({
      ok: true,
      orderId: order.id,
      status: "PAID",
      downloadToken: token,
      downloadUrl:
        `/api/download/${encodeURIComponent(order.id)}` +
        `?token=${encodeURIComponent(token)}`
    });
  }
);

// ============================================================
// API: Claim download
//
// Frontend gọi sau khi phát hiện đơn đã PAID.
// ============================================================

app.post(
  "/api/order/:orderId/claim-download",
  (req, res) => {

    const order = db
      .prepare(
        "SELECT * FROM orders WHERE id=?"
      )
      .get(req.params.orderId);

    if (!order) {
      return res.status(404).json({
        error: "Không tìm thấy đơn hàng"
      });
    }

    if (order.status !== "PAID") {
      return res.status(403).json({
        error: "Chưa thanh toán"
      });
    }

    const token = createDownloadToken(
      order.id
    );

    res.json({
      downloadUrl:
        `/api/download/${encodeURIComponent(order.id)}` +
        `?token=${encodeURIComponent(token)}`
    });
  }
);

// ============================================================
// API: Download
//
// KHÔNG dùng Google API.
// KHÔNG dùng Service Account.
//
// Sau khi kiểm tra token hợp lệ:
// Node.js -> HTTP 302 -> Google Drive LinkFile
// ============================================================

app.get(
  "/api/download/:orderId",
  async (req, res) => {

    try {

      const order = db
        .prepare(
          "SELECT * FROM orders WHERE id=?"
        )
        .get(req.params.orderId);

      if (
        !order ||
        order.status !== "PAID"
      ) {
        return res.status(403).send(
          "Chưa thanh toán"
        );
      }

      const token = clean(
        req.query.token
      );

      if (!token) {
        return res.status(403).send(
          "Thiếu download token"
        );
      }

      const tokenHash = hashToken(token);

      if (
        tokenHash !== order.download_token_hash ||
        !order.download_token_expiry ||
        new Date(order.download_token_expiry) < new Date()
      ) {
        return res.status(403).send(
          "Link tải không hợp lệ hoặc đã hết hạn"
        );
      }

      const p = (
        await loadProducts()
      ).get(order.ma_file);

      if (
        !p ||
        p.TrangThai !== "1"
      ) {
        return res.status(404).send(
          "File không còn khả dụng"
        );
      }

      const linkFile = clean(
        p.LinkFile
      );

      if (
        !linkFile.startsWith(
          "https://drive.google.com/"
        )
      ) {
        return res.status(500).send(
          "Link Google Drive không hợp lệ"
        );
      }

      // Ghi nhận lượt tải
      db.prepare(`
        UPDATE orders
        SET download_count=download_count+1
        WHERE id=?
      `).run(order.id);

      // Redirect trực tiếp tới Google Drive
      return res.redirect(
        302,
        linkFile
      );

    } catch (e) {

      console.error(e);

      return res.status(500).send(
        "Không tải được file"
      );
    }
  }
);

// ============================================================
// API: Zalo request
//
// Frontend -> Node.js -> n8n -> Zalo
//
// URL n8n không lộ ra frontend.
// ============================================================

app.post(
  "/api/zalo-request",
  async (req, res) => {

    try {

      const {
        maFile,
        soDienThoai
      } = req.body || {};

      const ma = clean(
        maFile
      ).toLowerCase();

      const phone = clean(
        soDienThoai
      ).replace(/[^\d+]/g, "");

      const p = (
        await loadProducts()
      ).get(ma);

      if (
        !p ||
        p.TrangThai !== "1"
      ) {
        return res.status(404).json({
          error: "Không tìm thấy sản phẩm"
        });
      }

      if (
        !/^(\+84|0)\d{8,10}$/.test(phone)
      ) {
        return res.status(400).json({
          error: "Số Zalo không hợp lệ"
        });
      }

      const webhookUrl =
        process.env.N8N_ZALO_WEBHOOK_URL;

      if (!webhookUrl) {
        return res.status(500).json({
          error:
            "N8N_ZALO_WEBHOOK_URL chưa được cấu hình"
        });
      }

      const r = await axios.post(
        webhookUrl,
        {
          sdt: phone,
          ma_file: ma,
          ten: p.Ten,
          gia: p.Gia
        },
        {
          timeout: 15000,
          headers: {
            "x-zalo-secret":
              process.env.N8N_ZALO_SECRET || ""
          }
        }
      );

      res.json({
        ok: true,
        result: r.data
      });

    } catch (e) {

      console.error(e);

      res.status(502).json({
        error:
          "Không gửi được yêu cầu Zalo"
      });
    }
  }
);

// ============================================================
// Frontend
//
// Express 5:
// Không dùng app.get("*")
// ============================================================

app.get(
  "/{*splat}",
  (req, res) => {
    res.sendFile(
      "/app/public/index.html"
    );
  }
);

// ============================================================
// Start server
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      `gs-payment listening on :${PORT}`
    );
  }
);
