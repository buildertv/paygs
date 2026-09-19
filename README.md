# gs-payment

MVP thanh toán QR + tải file Google Drive, chạy Node.js/Express + Docker.

## 1. Cấu hình

cp .env.example .env

Sửa:
- PRODUCT_CSV_URL
- BANK_CODE
- BANK_ACCOUNT
- BANK_ACCOUNT_NAME
- PAYMENT_WEBHOOK_SECRET
- N8N_ZALO_WEBHOOK_URL
- N8N_ZALO_SECRET

## 2. Google Sheet

Header đúng:
MaFile | Ten | Gia | LinkFile | LinkVideo | TrangThai

PRODUCT_CSV_URL có thể là:
https://docs.google.com/spreadsheets/d/ID/export?format=csv&gid=0

Link CSV chỉ nằm ở backend .env, không gửi xuống trình duyệt.

## 3. Google Drive

LinkFile trong Google Sheet là link Google Drive trực tiếp, ví dụ:
https://drive.google.com/file/d/FILE_ID/view

Sau khi thanh toán, server xác thực OrderID + token rồi redirect 302 tới chính LinkFile này.
Server không cần Google Service Account và không proxy nội dung file.


## 4. n8n thanh toán

n8n tự xử lý SePay theo logic hiện có.

Sau khi xác nhận:
POST https://gs.hoangtuan.net/api/payment-confirm

Header:
x-payment-secret: <PAYMENT_WEBHOOK_SECRET>

JSON:
{
  "orderId": "HT260919-ABC123",
  "amount": 300000,
  "status": "PAID"
}

## 5. n8n Zalo

Web -> Node.js -> n8n.

Node.js POST:
{
  "sdt": "09xxxxxxxx",
  "ma_file": "v199",
  "ten": "...",
  "gia": 300000
}

Node.js gửi header x-zalo-secret.

## 6. Deploy

mkdir -p credentials data
# copy service-account.json vào credentials/

docker compose up -d --build

Nginx Proxy Manager:
gs.hoangtuan.net -> 127.0.0.1:3010
