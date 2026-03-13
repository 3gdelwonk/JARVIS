# SPECS.md — Technical Specifications

## 1. Database Schema (Dexie.js / IndexedDB)

### Products Table
```typescript
interface Product {
  id?: number;                    // Auto-increment
  barcode: string;                // EAN-13 from Smart Retail (e.g., "9310036040385")
  invoiceCode: string;            // 8-digit with leading zeros as on invoice (e.g., "00019100")
  itemNumber: string;             // Without leading zeros — VERIFIED as Quick Order item number (e.g., "19100")
  name: string;                   // Canonical name from invoice
  smartRetailName?: string;       // Name from Smart Retail (may differ)
  category: "fresh" | "flavoured" | "uht" | "specialty";
  isGstBearing: boolean;          // Flavoured milk = GST, plain milk = GST-free
  active: boolean;
  
  // Order unit info (from Lactalis portal)
  orderUnit: string;              // e.g., "Crate of 9", "Carton of 6"
  unitsPerOrder: number;          // e.g., 9, 6, 16, 28
  
  // Reorder settings
  minStockLevel: number;          // Reorder trigger point
  defaultOrderQty: number;        // Typical order quantity (from invoice history)
  targetDaysOfStock: number;      // Default 4
  
  // Pricing
  lactalisCostPrice: number;      // Current cost from Lactalis (ex-GST)
  metcashCostPrice?: number;      // Cost from Metcash (for comparison)
  sellPrice: number;              // Current sell price from Smart Retail
  
  createdAt: Date;
  updatedAt: Date;
}
// Indexes: barcode (unique), invoiceCode (unique), itemNumber, category, active
```

### StockSnapshots Table
```typescript
interface StockSnapshot {
  id?: number;
  productId: number;
  barcode: string;
  qoh: number;                    // Quantity on hand (may be negative)
  importedAt: Date;               // When CSV was imported
  source: "item_maintenance" | "item_stock_report";
  importBatchId: string;          // Groups rows from same import
}
// Indexes: [productId, importedAt], importBatchId
```

### DeliverySchedule Table
```typescript
interface DeliverySlot {
  id?: number;
  deliveryDate: string;           // YYYY-MM-DD
  orderCutoffDate: string;        // YYYY-MM-DD
  orderCutoffTime: string;        // HH:MM (24h)
  status: "upcoming" | "ordered" | "delivered" | "missed";
  orderId?: number;               // Link to Order if one was placed
  scrapedAt?: Date;               // When scraped from portal
  manualEntry: boolean;           // Was this manually entered or scraped
}
// Indexes: deliveryDate, status, [orderCutoffDate, orderCutoffTime]
```

### Orders Table
```typescript
interface Order {
  id?: number;
  deliveryDate: string;           // Expected delivery date
  createdAt: Date;                // When the order was generated
  approvedAt?: Date;              // When owner approved
  submittedAt?: Date;             // When uploaded to Lactalis
  status: "draft" | "approved" | "submitted" | "delivered" | "cancelled";
  totalCostEstimate: number;      // Sum of line items
  totalCostActual?: number;       // From invoice after delivery
  lactalisOrderNumber?: string;   // Purchase Order number from portal
  invoiceNumber?: string;         // Document No from Lactalis invoice
  notes?: string;
}
// Indexes: status, deliveryDate, createdAt
```

### OrderLines Table
```typescript
interface OrderLine {
  id?: number;
  orderId: number;
  productId: number;
  itemNumber: string;
  productName: string;
  suggestedQty: number;           // What the system suggested
  approvedQty: number;            // What the owner approved
  deliveredQty?: number;          // What was actually delivered
  unitPrice: number;              // Expected price per unit
  actualUnitPrice?: number;       // From invoice
  lineTotal: number;              // approvedQty × unitPrice
}
// Indexes: orderId, productId
```

### InvoiceRecords Table
```typescript
interface InvoiceRecord {
  id?: number;
  documentNumber: string;         // e.g., "242878938"
  documentType: "invoice" | "credit_note" | "adjustment";
  dateOrdered: string;            // DD.MM.YYYY from invoice header
  invoiceDate: string;
  totalAmount: number;
  parsedAt: Date;
  rawText?: string;               // Original parsed text for debugging
}
// Indexes: documentNumber (unique), invoiceDate
```

### InvoiceLines Table
```typescript
interface InvoiceLine {
  id?: number;
  invoiceRecordId: number;
  deliveryNoteNumber: string;     // e.g., "221209"
  deliveryDate: string;           // e.g., "19.1.2026"
  purchaseOrderNumber: string;    // e.g., "1660698"
  productCode: string;            // 8-digit with zeros, e.g., "00019100"
  productName: string;
  quantity: number;
  unitType: "EA" | "CTN";
  listPrice: number;
  lineDiscount?: number;
  containerScheme?: number;
  gst?: number;
  extendedPrice: number;
  pricePerItem: number;
}
// Indexes: [invoiceRecordId], productCode, deliveryDate
```

### PriceHistory Table
```typescript
interface PriceRecord {
  id?: number;
  productId: number;
  invoiceCode: string;
  effectiveDate: string;
  costPrice: number;              // Price Per Item from invoice
  source: "invoice" | "smart_retail" | "portal";
}
// Indexes: [productId, effectiveDate], invoiceCode
```

---

## 2. PWA Modules

### 2.1 CSV Import Module (`src/pwa/lib/csvImporter.ts`)

**Smart Retail Item Maintenance Parser**
```
Input: CSV/XLSX with 13 columns
Process:
  1. Detect column headers (handle slight variations)
  2. Filter: Active = "Yes", Department Name = "MILK"
  3. For each row:
     - If Supplier Code = "01240657" → Lactalis direct pricing
     - If Supplier Code = "90770" → Metcash pricing
  4. Group by Barcode → create/update Product with both price points
  5. Flag anomalies: cost > $50 per unit (likely carton cost in wrong field)
Output: Updated products in IndexedDB, import log
```

**Smart Retail Item Stock Report Parser**
```
Input: CSV/XLSX with 20 columns
Process:
  1. Parse all rows, match to existing products by Barcode
  2. Store QOH as StockSnapshot with timestamp
  3. Calculate velocity: (prev_snapshot.qoh - current.qoh) / days_between
  4. Store Carton Qty for order unit reference
Output: StockSnapshots in IndexedDB, velocity calculations
```

### 2.2 Invoice Parser Module (`src/pwa/lib/invoiceParser.ts`)

**PDF Invoice Parser**
```
Input: Lactalis PDF invoice (text already extracted via PDF.js)
Process:
  1. Extract header: Document No, Date Ordered, Invoice Date, Total Amount
  2. Detect document type: "TAX INVOICE" vs "Adjustment Note" vs "Credit Adjustment Note"
  3. For each "Delivery Note XXXXXX for DD.MM.YYYY Purchase Order XXXXXXX":
     a. Extract delivery note number, delivery date, PO number
     b. Parse line items until "Sub-total" or next "Delivery Note"
     c. Each line: Product Name, Product Code (8-digit), Quantity, Unit, List Price,
        optional Line Disc/Container/GST, Extended Price, Price Per Item
  4. Handle multi-page invoices (same structure continues)
  5. Extract totals: Totals row, GST, Total taxable/tax-free, Total Amount
Output: InvoiceRecord + InvoiceLines in IndexedDB
```

**Regex patterns for line items:**
```
Standard line: /^(.+?)\s+(0{2,}\d+)\s+(\d+)\s+(EA|CTN)\s+([\d.]+)\s+([\d.]+[-]?)?\s*([\d.]+)?\s*([\d.]+)?\s+([\d.]+)\s+([\d.]+)$/
Delivery note header: /^Delivery Note (\d+) for ([\d.]+\.\d+\.\d+) Purchase Order (\d+)/
Credit note indicator: "TOTAL AMOUNT: $ X.XX CR" or "Adjustment Note" or "Credit Adjustment Note"
```

### 2.3 Forecast Engine (`src/pwa/lib/forecastEngine.ts`)

```typescript
interface Forecast {
  productId: number;
  avgDailySales: number;          // Units per day
  avgPerDelivery: number;         // Average order quantity from invoice history
  deliveryFrequency: number;      // Times per week this product is ordered
  reorderPoint: number;           // When to flag for reorder
  suggestedQty: number;           // For next order
  confidence: "high" | "medium" | "low";  // Based on data points available
  daysUntilStockout?: number;     // Estimated from current stock + velocity
}

// Algorithm:
// 1. Primary: Invoice history → avg qty per delivery, frequency
// 2. Secondary: Stock velocity from Smart Retail snapshots (cross-validation)
// 3. Adjustments: day-of-week patterns, manual multipliers, seasonal
// 4. Lead time: hours between cutoff and delivery (from schedule)
// 5. Safety stock: 1.5 × std_dev × sqrt(lead_time_days)
```

### 2.4 Order Builder (`src/pwa/components/OrderBuilder.tsx`)

```
Flow:
1. Select delivery slot (from schedule)
2. System generates suggested order:
   - For each active product:
     - Calculate suggested qty from forecast engine
     - Show: current stock (if available), avg daily sales, days of stock remaining
     - Color code: red (stockout risk), amber (low), green (ok)
3. Owner adjusts quantities (+/- buttons, direct input)
4. Order summary: total items, total cost estimate, comparison to typical order
5. Approve → generates order record
6. Export options:
   - "Copy for Paste" → clipboard: "19100,18;18532,6;40248,12"
   - "Download CSV" → file: Column A = SKU, Column B = qty
   - "Send to Extension" → store in shared location for Chrome extension pickup
```

### 2.5 Dashboard (`src/pwa/components/Dashboard.tsx`)

```
Sections:
1. Next Order: countdown to cutoff, suggested order summary
2. Stock Health: color-coded bar (critical/low/ok/good)
3. Reorder Alerts: products that need ordering, sorted by urgency
4. Recent Orders: last 5 orders with status
5. Margin Alerts: products where margin has dropped below threshold
6. Weekly Spend: chart of last 8 weeks spend
```

### 2.6 Margin Analysis (`src/pwa/components/MarginAnalysis.tsx`)

```
Per Product:
- Lactalis cost (from latest invoice)
- Metcash cost (from Smart Retail Item Maintenance)
- Sell price (from Smart Retail)
- GP%: (sell - cost) / sell × 100
- Cheaper supplier indicator
- Price trend (from PriceHistory)
- Daily profit estimate: margin × avg daily sales

Views:
- Sort by: lowest margin, highest margin, most daily profit
- Filter by: category, supplier, margin range
- Alert: products below 20% margin threshold
```

---

## 3. Chrome Extension Modules

### 3.1 Manifest (`extension/manifest.json`)
```json
{
  "manifest_version": 3,
  "name": "IGA Milk Manager",
  "version": "1.0.0",
  "description": "Auto-fill Lactalis Quick Order from approved orders",
  "permissions": ["storage", "activeTab", "scripting"],
  "host_permissions": ["https://*.lactalis.com.au/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["https://*.lactalis.com.au/*"],
    "js": ["content-scripts/main.js"]
  }],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": "icons/icon48.png"
  }
}
```

### 3.2 Content Script — Quick Order Auto-Fill (`extension/content-scripts/quickOrder.js`)
```
Trigger: URL matches Lactalis Quick Order page
Flow:
1. Check chrome.storage for pending approved order
2. If found, show floating button: "Fill Order (18 items, ~$634)"
3. On click:
   Option A — Paste method:
     - Find paste textarea
     - Set value to "19100,18;18532,6;..." format
     - Trigger input event
     - Click "Verify Order" button
   Option B — File upload method:
     - Generate CSV blob
     - Create File object
     - Set on file input via DataTransfer API
     - Trigger change event
4. Wait for Lactalis to verify → show confirmation
5. DO NOT click "Create Order" — owner does this manually
6. After owner submits, detect success and update order status in storage
```

### 3.3 Content Script — Schedule Scraper (`extension/content-scripts/scheduleScraper.js`)
```
Trigger: Any Lactalis page load
Flow:
1. Read header banner text
2. Parse: delivery date, order cutoff date+time
3. Store in chrome.storage.local with timestamp
4. If "Manage my deliveries" page detected, scrape full calendar
```

### 3.4 Popup UI (`extension/popup/popup.html`)
```
Shows:
- Connection status (green = Lactalis page detected)
- Next delivery date + cutoff
- Pending orders count
- "Upload Order" button (disabled if no pending orders)
- "Refresh Schedule" button
- Link to PWA
```

---

## 4. Data Flow Diagrams

### Order Creation Flow
```
Smart Retail CSV → [Import] → IndexedDB (products, stock)
Lactalis Invoices → [Parse] → IndexedDB (order history, prices)
                                    ↓
                            [Forecast Engine]
                                    ↓
                            Suggested Order
                                    ↓
                        [Owner Reviews on Phone]
                                    ↓
                            Approved Order
                                    ↓
                    [Save to shared storage / file]
                                    ↓
                    [Chrome Extension detects]
                                    ↓
                    [Auto-fill Lactalis Quick Order]
                                    ↓
                    [Owner clicks Create Order on portal]
```

### Invoice Reconciliation Flow
```
Lactalis Invoice PDF → [Parse] → Invoice Lines
                                      ↓
                              [Match to Order]
                                      ↓
                     Compare: ordered qty vs delivered qty
                     Compare: expected price vs actual price
                                      ↓
                              Flag discrepancies
                              Update price history
                              Feed into forecast model
```

---

## 5. Error Handling & Edge Cases

### CSV Import
- Handle BOM (byte order mark) in CSV files
- Handle both comma and tab delimiters
- Handle quoted fields with commas inside
- Skip rows where Barcode is empty or "NH"
- Flag duplicate barcodes with different data
- Warn if expected columns are missing

### Invoice Parsing
- Handle multi-page invoices (header repeats on each page)
- Handle Credit Notes (amounts are CR, quantities are reversals)
- Handle promotional discounts (Line Disc, Container Scheme columns)
- Handle products where code is concatenated with name (e.g., "PAULS SMARTER WHITE 2% FAT MILK BTL 1L00039466")
- Handle both EA (each) and CTN (carton) unit types
- Handle the ** suffix on some product names (e.g., "PAULS ZYMIL FULL CREAM MILK 6x1L**")

### Chrome Extension
- Handle Lactalis session timeout (re-login needed)
- Handle portal UI changes (selectors may break)
- Gracefully degrade if Quick Order page structure changes
- Never auto-submit an order — always require manual "Create Order" click
- Rate limit scraping to avoid being blocked

### Ordering
- Validate: no zero quantities in final order
- Validate: order total within expected range (flag if >2× or <0.5× typical)
- Warn if ordering a product not ordered in last 4 weeks
- Warn if skipping a product that was ordered every delivery

---

## 6. Testing Strategy

### Unit Tests
- CSV parser: test with actual Smart Retail export format variations
- Invoice parser: test with each invoice type (standard, credit, adjustment)
- Forecast engine: test with known historical data → expected suggestions
- Price calculation: test margin calculations with and without GST

### Integration Tests
- Full flow: import CSV → forecast → generate order → export CSV
- Invoice parse → reconcile with order → update prices

### Manual Test Scenarios
- Import a Smart Retail CSV, verify product count and prices
- Parse a Lactalis invoice, verify all line items extracted correctly
- Generate an order, copy paste format, verify it matches Lactalis Quick Order expectations
- Install Chrome extension, verify it detects Lactalis pages
- Test extension paste/upload on Lactalis Quick Order page

---

## 7. Deployment

### PWA
1. `npm run build` → generates static files in `dist/`
2. Push to GitHub → GitHub Pages auto-deploys
3. Custom domain optional (not needed)
4. Service worker caches everything for offline use

### Chrome Extension
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/` directory
4. Extension activates on all Lactalis pages

### Updates
- PWA: push to GitHub → auto-deploys, service worker refreshes cache
- Extension: update files → click reload on extensions page
